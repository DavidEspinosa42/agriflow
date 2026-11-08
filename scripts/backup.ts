import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { controllerDbPath, runCli } from "./lib.ts";

const PATTERN = /^controller-\d{8}-\d{6}\.db$/;

/**
 * Online backup of the controller database using SQLite's backup API, which is safe while the
 * controller is running (copying the file of a WAL database is not). The copy is verified and
 * only the newest `keep` backups are retained.
 */
export async function backupController(
  source: DatabaseSync,
  directory: string,
  now: Date,
  keep: number,
): Promise<string> {
  mkdirSync(directory, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const destination = join(directory, `controller-${stamp}.db`);
  await backup(source, destination);
  const copy = new DatabaseSync(destination);
  try {
    // A single self-contained file: no -wal or -shm files are left next to the backup.
    copy.exec("PRAGMA journal_mode = DELETE");
    const row = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (row.integrity_check !== "ok") throw new Error("backup failed its integrity check");
  } finally {
    copy.close();
  }
  const old = readdirSync(directory)
    .filter((name) => PATTERN.test(name))
    .sort()
    .slice(0, -keep);
  for (const name of old) rmSync(join(directory, name), { force: true });
  return destination;
}

if (import.meta.main) {
  await runCli(async () => {
    const { values } = parseArgs({
      options: {
        out: { type: "string", default: process.env["BACKUP_DIR"] ?? "./backups" },
        keep: { type: "string", default: "14" },
      },
    });
    const keep = Number(values.keep);
    if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a positive integer");
    const path = controllerDbPath();
    // Opening a missing file would create an empty database and back that up instead.
    if (!existsSync(path)) throw new Error(`controller database not found at ${path}`);
    const db = new DatabaseSync(path);
    try {
      const file = await backupController(db, resolve(values.out ?? "./backups"), new Date(), keep);
      console.log(`backup written to ${file}`);
    } finally {
      db.close();
    }
  });
}
