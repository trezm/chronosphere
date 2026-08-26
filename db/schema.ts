import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pullRequestStates = sqliteTable("pull_request_states", {
  viewer: text("viewer").notNull(),
  repository: text("repository").notNull(),
  pullNumber: integer("pull_number").notNull(),
  headSha: text("head_sha").notNull(),
  revision: integer("revision").notNull(),
  state: text("state").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.viewer, table.repository, table.pullNumber, table.headSha] }),
]);
