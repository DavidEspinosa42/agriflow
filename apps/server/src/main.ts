import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { connect, runMigrations } from "./db/connection.ts";
import { MysqlRepository } from "./db/mysql-repository.ts";
import { buildApp } from "./http/app.ts";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  SERVER_HOST: z.string().default("127.0.0.1"),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Built manager dashboard. Defaults to the dashboard build in this repository. */
  MANAGER_DIST: z.string().optional(),
  SERVER_UTC_OFFSET_MINUTES: z.coerce.number().int().min(-840).max(840).default(-180),
});

const env = Env.parse(process.env);
await runMigrations(env.DATABASE_URL);
// @fastify/static requires an absolute root.
const managerDist = resolve(
  env.MANAGER_DIST ??
    fileURLToPath(new URL("../../dashboard/dist/manager/browser", import.meta.url)),
);
const connection = connect(env.DATABASE_URL);
const app = buildApp({
  repository: new MysqlRepository(connection.db),
  now: () => Date.now(),
  utcOffsetMinutes: env.SERVER_UTC_OFFSET_MINUTES,
  ...(existsSync(managerDist) ? { staticRoot: managerDist } : {}),
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await connection.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: env.SERVER_HOST, port: env.SERVER_PORT });
