import { z } from "zod";
import { connect, runMigrations } from "./db/connection.ts";
import { MysqlRepository } from "./db/mysql-repository.ts";
import { buildApp } from "./http/app.ts";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  SERVER_HOST: z.string().default("127.0.0.1"),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  SERVER_UTC_OFFSET_MINUTES: z.coerce.number().int().min(-840).max(840).default(-180),
});

const env = Env.parse(process.env);
await runMigrations(env.DATABASE_URL);
const connection = connect(env.DATABASE_URL);
const app = buildApp({
  repository: new MysqlRepository(connection.db),
  now: () => Date.now(),
  utcOffsetMinutes: env.SERVER_UTC_OFFSET_MINUTES,
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await connection.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: env.SERVER_HOST, port: env.SERVER_PORT });
