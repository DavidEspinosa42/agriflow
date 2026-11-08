import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "./migrations.ts";

/**
 * Open the controller database with durable settings and apply pending migrations.
 * WAL with synchronous=FULL means a committed checkpoint survives a power cut.
 */
export function openDatabase(path: string): DatabaseSync {
  // SQLite creates the file but not its folder.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  // Makes INSERT OR REPLACE fire the append-only delete triggers instead of bypassing them.
  db.exec("PRAGMA recursive_triggers = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function migrate(db: DatabaseSync): void {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `database schema version ${current} is newer than this controller (${migrations.length})`,
    );
  }
  for (let version = current; version < migrations.length; version++) {
    const sql = migrations[version];
    if (sql === undefined) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
