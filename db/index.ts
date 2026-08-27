import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  const bindings = env as unknown as { DB?: D1Database };
  if (!bindings.DB) {
    throw new Error("Persistent PR state is unavailable because the database binding is missing.");
  }
  return drizzle(bindings.DB, { schema });
}
