import { SessionId, type SessionRecord } from "@agriflow/core";
import { drizzle } from "drizzle-orm/mysql2";
import fc from "fast-check";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, runMigrations } from "./connection.ts";
import { MysqlSyncRepository } from "./mysql-repository.ts";
import { hashToken, MemorySyncRepository, type SyncRepository } from "./repository.ts";
import { devices, transactions } from "./schema.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const record = (n: number, liters = 10): SessionRecord =>
  ({
    sessionId: SessionId.parse(uuid(n)),
    deviceId: "pump-01",
    tankId: "tank-1",
    operatorId: "op-1",
    machineId: "m1",
    startedAtMs: 1000,
    endedAtMs: 2000,
    liters,
    endReason: "operator_stop",
  }) as SessionRecord;

/** The behavior every repository must have, whatever it stores into. */
function contract(
  name: string,
  setup: () => Promise<{
    repo: SyncRepository;
    count: () => Promise<number>;
    reset: () => Promise<void>;
  }>,
  runs: number,
) {
  describe(`${name} sync repository`, () => {
    let ctx: Awaited<ReturnType<typeof setup>>;
    beforeAll(async () => {
      ctx = await setup();
    });

    it("stores once, then reports duplicates and conflicts without changing data", async () => {
      await ctx.reset();
      expect(await ctx.repo.storeBatch([record(1)], 1)).toEqual([
        { sessionId: uuid(1), status: "stored" },
      ]);
      expect(await ctx.repo.storeBatch([record(1)], 2)).toEqual([
        { sessionId: uuid(1), status: "duplicate" },
      ]);
      expect(await ctx.repo.storeBatch([record(1, 99)], 3)).toEqual([
        { sessionId: uuid(1), status: "conflict" },
      ]);
      expect(await ctx.count()).toBe(1);
    });

    it("treats a repeated id inside one batch as a duplicate", async () => {
      await ctx.reset();
      const acks = await ctx.repo.storeBatch([record(2), record(2), record(3)], 1);
      expect(acks.map((a) => a.status)).toEqual(["stored", "duplicate", "stored"]);
      expect(await ctx.count()).toBe(2);
    });

    it("round-trips fractional liters exactly so replays stay duplicates", async () => {
      await ctx.reset();
      const liters = 12.340000000000002;
      await ctx.repo.storeBatch([record(4, liters)], 1);
      expect((await ctx.repo.storeBatch([record(4, liters)], 2))[0]?.status).toBe("duplicate");
    });

    it("yields exactly one row per session id for any order and duplication (invariant 3)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 20 }),
          fc.integer({ min: 1, max: 5 }),
          async (ids, chunk) => {
            await ctx.reset();
            for (let i = 0; i < ids.length; i += chunk) {
              await ctx.repo.storeBatch(
                ids.slice(i, i + chunk).map((n) => record(n)),
                i,
              );
            }
            expect(await ctx.count()).toBe(new Set(ids).size);
          },
        ),
        { numRuns: runs },
      );
    });
  });
}

contract(
  "in-memory",
  async () => {
    let repo = new MemorySyncRepository();
    const view = { repo } as { repo: SyncRepository };
    return {
      get repo() {
        return view.repo;
      },
      count: async () => repo.all().length,
      reset: async () => {
        repo = new MemorySyncRepository();
        view.repo = repo;
      },
    };
  },
  200,
);

/** True only if the database that will actually be selected has a name ending in _test. */
function isTestDatabase(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "mysql:" && /^\/[A-Za-z0-9_]*_test$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

const url = process.env["MYSQL_TEST_URL"];

describe.skipIf(url === undefined)("mysql", () => {
  // Safety: this suite drops tables, so it only runs against a database whose name ends in _test.
  const testUrl = url ?? "";
  const ok = isTestDatabase(testUrl);

  it("requires a *_test database", () => {
    expect(ok).toBe(true);
  });

  if (!ok) return;

  const conn = connect(testUrl);
  const repo = new MysqlSyncRepository(conn.db);

  beforeAll(async () => {
    const admin = await mysql.createConnection({ uri: testUrl });
    await admin.query("DROP TABLE IF EXISTS transactions, devices, __drizzle_migrations");
    await admin.end();
    await runMigrations(testUrl);
  });

  afterAll(async () => {
    await conn.close();
  });

  it("finds only active devices by token hash", async () => {
    const db = drizzle({ client: mysql.createPool({ uri: testUrl, connectionLimit: 1 }) });
    await db.insert(devices).values({
      deviceId: "pump-01",
      tankId: "tank-1",
      tokenHash: hashToken("device-token-0123456789abcdef"),
      createdAtMs: 1,
    });
    expect(await repo.findDeviceByTokenHash(hashToken("device-token-0123456789abcdef"))).toEqual({
      deviceId: "pump-01",
      tankId: "tank-1",
    });
    expect(
      await repo.findDeviceByTokenHash(hashToken("other-token-0123456789abcdef")),
    ).toBeUndefined();
    await conn.db.update(devices).set({ revoked: true });
    expect(
      await repo.findDeviceByTokenHash(hashToken("device-token-0123456789abcdef")),
    ).toBeUndefined();
  });

  it("refuses to update or delete a stored transaction", async () => {
    await repo.storeBatch([record(50)], 1);
    const admin = await mysql.createConnection({ uri: testUrl });
    await expect(admin.query("UPDATE transactions SET liters = 1")).rejects.toThrow(/append-only/);
    await expect(admin.query("DELETE FROM transactions")).rejects.toThrow(/append-only/);
    await admin.end();
  });

  it("stores concurrent replays of the same batch exactly once", async () => {
    const batch = [record(60), record(61), record(62)];
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.storeBatch(batch, 1)));
    const stored = results.flat().filter((a) => a.status === "stored");
    expect(stored).toHaveLength(3);
    const rows = await conn.db.select().from(transactions);
    expect(rows.filter((r) => Number(r.sessionId.slice(-2)) >= 60)).toHaveLength(3);
  });

  contract(
    "mysql",
    async () => ({
      repo,
      count: async () => (await conn.db.select().from(transactions)).length,
      reset: async () => {
        const admin = await mysql.createConnection({ uri: testUrl });
        await admin.query("DROP TRIGGER IF EXISTS transactions_no_delete");
        await admin.query("DELETE FROM transactions");
        await admin.query(
          "CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'transactions are append-only'",
        );
        await admin.end();
      },
    }),
    15,
  );
});
