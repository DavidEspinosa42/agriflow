import { fileURLToPath } from "node:url";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

export interface Connection {
  readonly db: MySql2Database;
  close(): Promise<void>;
}

export function connect(url: string): Connection {
  const pool = mysql.createPool({ uri: url, connectionLimit: 10 });
  return { db: drizzle({ client: pool }), close: () => pool.end() };
}

/** Apply pending migrations on a dedicated single connection, as Drizzle recommends for DDL. */
export async function runMigrations(url: string): Promise<void> {
  const client = await mysql.createConnection({ uri: url });
  try {
    await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS });
  } finally {
    await client.end();
  }
}
