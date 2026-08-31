import { drizzle } from "drizzle-orm/d1";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

const MISSING_BINDING = "Persistent PR state is unavailable because the database binding is missing.";

const MIGRATIONS_FOLDER = "drizzle";
const DEFAULT_SQLITE_FILE = ".data/chronosphere.sqlite";
const RAILWAY_SQLITE_FILE = "chronosphere.sqlite";

// D1 and libsql are both async SQLite drivers, so the query builder the store
// uses is identical; only the driver-specific run result differs.
export type Database = BaseSQLiteDatabase<"async", unknown, typeof schema>;

// "cloudflare:workers" only resolves on the Workers runtime. A static import
// crashes Node's ESM loader at boot (e.g. `vinext start` on Railway) before a
// single request is served, so the module is loaded lazily and its absence is
// reported per-request instead.
async function workersEnv(): Promise<Record<string, unknown> | null> {
  try {
    const { env } = await import("cloudflare:workers");
    return env as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Node-only modules must never be reachable from the Workers bundle. Routing
// them through a non-literal specifier keeps the bundler from resolving them
// at build time; the Workers runtime never evaluates this branch.
function nodeImport(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}

let nodeDatabase: Promise<Database> | null = null;

function sqliteFile(path: typeof import("node:path")): string {
  const configured = process.env.SQLITE_PATH?.trim();
  if (configured) return path.resolve(configured);

  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (volume) return path.resolve(volume, RAILWAY_SQLITE_FILE);

  return path.resolve(process.cwd(), DEFAULT_SQLITE_FILE);
}

// Opens the file-backed database and applies the generated migrations. The
// resulting promise is memoized by getDb(), so concurrent requests share a
// single client and a single migration run.
async function openNodeDatabase(): Promise<Database> {
  const [path, fs, libsql, driver, migrator] = await Promise.all([
    nodeImport("node:path") as Promise<typeof import("node:path")>,
    nodeImport("node:fs/promises") as Promise<typeof import("node:fs/promises")>,
    nodeImport("@libsql/client") as Promise<typeof import("@libsql/client")>,
    nodeImport("drizzle-orm/libsql") as Promise<typeof import("drizzle-orm/libsql")>,
    nodeImport("drizzle-orm/libsql/migrator") as Promise<typeof import("drizzle-orm/libsql/migrator")>,
  ]);

  const file = sqliteFile(path);
  await fs.mkdir(path.dirname(file), { recursive: true });

  const db = driver.drizzle(libsql.createClient({ url: `file:${file}` }), { schema });
  // drizzle-kit writes the migrations as a plain folder that ships with the
  // repository, and Railway starts the server from the repository root.
  await migrator.migrate(db, { migrationsFolder: path.resolve(process.cwd(), MIGRATIONS_FOLDER) });
  return db;
}

export async function getDb(): Promise<Database> {
  const env = await workersEnv();
  if (env) {
    // Workers: D1 only. Its migrations are managed outside the application.
    const binding = env.DB as D1Database | undefined;
    if (!binding) throw new Error(MISSING_BINDING);
    return drizzle(binding, { schema });
  }

  if (!nodeDatabase) {
    // A failed open must not poison every later request.
    nodeDatabase = openNodeDatabase().catch((error) => {
      nodeDatabase = null;
      throw error;
    });
  }
  return nodeDatabase;
}
