import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import * as schema from "./schema";

export * from "./schema";
export { migrate } from "./migrate";

/**
 * One SQLite file, opened once. Cached on `globalThis` because Next re-evaluates
 * modules on every edit in dev, and a second connection would fight the first
 * for the write lock.
 */
declare global {
  var __cnpjDb: BetterSQLite3Database<typeof schema> | undefined;
  var __cnpjSqlite: Database.Database | undefined;
}

/**
 * Walks up to the workspace root so the database is one file for the whole
 * repo, not one per package that happens to be the cwd when a script runs.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function dbPath(): string {
  return process.env.CNPJ_DB_PATH ?? join(repoRoot(), "app.db");
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (globalThis.__cnpjDb) return globalThis.__cnpjDb;
  const sqlite = new Database(dbPath());
  // WAL lets the crawl write while a page reads. Without it the UI blocks on
  // every batch the worker commits.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  globalThis.__cnpjSqlite = sqlite;
  globalThis.__cnpjDb = drizzle(sqlite, { schema });
  return globalThis.__cnpjDb;
}

/**
 * The better-sqlite3 handle behind `getDb`, for bulk work in `scripts/`.
 *
 * Drizzle is the right tool for the app's one-row-at-a-time writes and the
 * wrong one for a backfill that touches every row: that would be one prepared
 * statement per company instead of one for the whole run. Scripts also cannot
 * import `drizzle-orm` directly — it is a dependency of this package, not of
 * the workspace root — so this is the supported way in.
 */
export function getSqlite(): Database.Database {
  getDb();
  return globalThis.__cnpjSqlite!;
}

export type Db = ReturnType<typeof getDb>;
export { schema };
