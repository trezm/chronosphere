import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

const MISSING_BINDING = "Persistent PR state is unavailable because the database binding is missing.";

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

export async function getDb() {
  const env = await workersEnv();
  const db = env?.DB as D1Database | undefined;
  if (!db) throw new Error(MISSING_BINDING);
  return drizzle(db, { schema });
}
