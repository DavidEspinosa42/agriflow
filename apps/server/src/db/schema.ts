import { bigint, boolean, double, index, mysqlTable, varchar } from "drizzle-orm/mysql-core";

/** A controller allowed to sync. Only a hash of its token is stored. */
export const devices = mysqlTable("devices", {
  deviceId: varchar("device_id", { length: 64 }).primaryKey(),
  tankId: varchar("tank_id", { length: 64 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  revoked: boolean("revoked").notNull().default(false),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
});

/**
 * One row per dispensing session. `session_id` is the primary key, so the database itself
 * guarantees at most one central transaction per session (invariant 3).
 */
export const transactions = mysqlTable(
  "transactions",
  {
    sessionId: varchar("session_id", { length: 36 }).primaryKey(),
    deviceId: varchar("device_id", { length: 64 }).notNull(),
    tankId: varchar("tank_id", { length: 64 }).notNull(),
    operatorId: varchar("operator_id", { length: 64 }).notNull(),
    machineId: varchar("machine_id", { length: 64 }).notNull(),
    startedAtMs: bigint("started_at_ms", { mode: "number" }).notNull(),
    endedAtMs: bigint("ended_at_ms", { mode: "number" }).notNull(),
    liters: double("liters").notNull(),
    endReason: varchar("end_reason", { length: 32 }).notNull(),
    receivedAtMs: bigint("received_at_ms", { mode: "number" }).notNull(),
  },
  (t) => [
    index("transactions_started_idx").on(t.startedAtMs),
    index("transactions_machine_idx").on(t.machineId),
  ],
);
