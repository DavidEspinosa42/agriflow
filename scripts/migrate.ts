import { parseArgs } from "node:util";
import { openDatabase, schemaVersion } from "../apps/controller/src/storage/database.ts";
import { runMigrations } from "../apps/server/src/db/connection.ts";
import { controllerDbPath, requireEnv, runCli } from "./lib.ts";

/** Apply pending migrations: `pnpm migrate [--target controller|server|all]`. */
await runCli(async () => {
  const { values } = parseArgs({ options: { target: { type: "string", default: "all" } } });
  const target = values.target;
  if (target !== "controller" && target !== "server" && target !== "all") {
    throw new Error("--target must be controller, server or all");
  }
  if (target !== "server") {
    const db = openDatabase(controllerDbPath());
    console.log(`controller database at schema version ${schemaVersion(db)}`);
    db.close();
  }
  if (target !== "controller") {
    await runMigrations(requireEnv("DATABASE_URL"));
    console.log("server database migrated");
  }
});
