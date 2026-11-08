import { SessionId, type SessionRecord } from "@agriflow/core";
import { drizzle } from "drizzle-orm/mysql2";
import fc from "fast-check";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  aggregate,
  type GroupBy,
  matches,
  type ReportRepository,
  type TransactionFilter,
} from "../reports/reports.ts";
import { connect, runMigrations } from "./connection.ts";
import { MysqlRepository } from "./mysql-repository.ts";
import { hashToken, MemoryRepository, type SyncRepository } from "./repository.ts";
import { devices, managers, transactions } from "./schema.ts";
import { issueDeviceToken, issueManagerToken, newToken } from "./tokens.ts";

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

// --- report queries ---------------------------------------------------------------------

const rec = (n: number, o: Record<string, unknown> = {}): SessionRecord =>
  ({ ...record(n), ...o }) as SessionRecord;

const DAY = 86_400_000;
// 2026-03-10T01:00:00Z is still 2026-03-09 in Argentina (UTC-3).
const T0 = Date.UTC(2026, 2, 10, 1, 0, 0);
const dataset: SessionRecord[] = [
  rec(101, { machineId: "T-12", operatorId: "op-1", startedAtMs: T0, liters: 40.5 }),
  rec(102, {
    machineId: "T-12",
    operatorId: "op-2",
    startedAtMs: T0 + 4 * 3_600_000,
    liters: 10.25,
  }),
  rec(103, { machineId: "H-03", operatorId: "op-1", startedAtMs: T0 + DAY, liters: 100 }),
  rec(104, { machineId: "H-03", operatorId: "op-2", startedAtMs: T0 + 2 * DAY, liters: 0.001 }),
  rec(105, {
    machineId: "T-12",
    operatorId: "op-1",
    startedAtMs: T0 + 2 * DAY,
    liters: 7.5,
    deviceId: "pump-02",
  }),
];

interface ReportCtx {
  repo: SyncRepository & ReportRepository;
  reset(): Promise<void>;
  addDevice(deviceId: string, tankId: string): Promise<void>;
  addManager(managerId: string, token: string): Promise<void>;
}

function reportContract(name: string, make: () => Promise<ReportCtx>) {
  describe(`${name} report queries`, () => {
    let ctx: ReportCtx;
    beforeAll(async () => {
      ctx = await make();
    });
    beforeEach(async () => {
      await ctx.reset();
      await ctx.addDevice("pump-01", "tank-1");
      await ctx.addDevice("pump-02", "tank-1");
      await ctx.addDevice("pump-03", "tank-2");
      await ctx.repo.storeBatch(dataset.slice(0, 4), 7000);
      await ctx.repo.storeBatch(dataset.slice(4), 9000);
    });

    const filters: TransactionFilter[] = [
      {},
      { machineId: "T-12" },
      { operatorId: "op-2" },
      { deviceId: "pump-02" },
      { fromMs: T0 + DAY, toMs: T0 + 2 * DAY },
      { fromMs: T0, toMs: T0 },
      { machineId: "H-03", operatorId: "op-1" },
    ];

    it("lists newest first with stable paging, totals and received time", async () => {
      const all = await ctx.repo.listTransactions({}, { limit: 50, offset: 0 });
      expect(all.total).toBe(5);
      expect(all.items.map((i) => i.startedAtMs)).toEqual(
        dataset.map((d) => d.startedAtMs).sort((a, b) => b - a),
      );
      expect(all.items.find((i) => i.sessionId === uuid(105))?.receivedAtMs).toBe(9000);
      const pages = [
        ...(await ctx.repo.listTransactions({}, { limit: 2, offset: 0 })).items,
        ...(await ctx.repo.listTransactions({}, { limit: 2, offset: 2 })).items,
        ...(await ctx.repo.listTransactions({}, { limit: 2, offset: 4 })).items,
      ];
      expect(pages.map((p) => p.sessionId)).toEqual(all.items.map((i) => i.sessionId));
    });

    it("filters like the reference implementation", async () => {
      for (const filter of filters) {
        const expected = dataset
          .filter((d) => matches(d, filter))
          .map((d) => d.sessionId)
          .sort();
        const got = await ctx.repo.listTransactions(filter, { limit: 50, offset: 0 });
        expect(got.items.map((i) => i.sessionId).sort()).toEqual(expected);
        expect(got.total).toBe(expected.length);
      }
    });

    it("aggregates consumption like the reference implementation", async () => {
      for (const groupBy of ["machine", "operator", "device", "day"] as GroupBy[]) {
        for (const offset of [0, -180]) {
          for (const filter of filters) {
            const expected = aggregate(
              dataset.filter((d) => matches(d, filter)),
              groupBy,
              offset,
            );
            expect(await ctx.repo.consumption(filter, groupBy, offset)).toEqual(expected);
          }
        }
      }
    });

    it("buckets days in the local time of the farm", async () => {
      const utc = await ctx.repo.consumption({ machineId: "T-12" }, "day", 0);
      const local = await ctx.repo.consumption({ machineId: "T-12" }, "day", -180);
      expect(utc.map((r) => r.key)).toEqual(["2026-03-10", "2026-03-12"]);
      expect(local.map((r) => r.key)).toEqual(["2026-03-09", "2026-03-10", "2026-03-11"]);
    });

    it("keeps identifiers that differ only in case apart", async () => {
      await ctx.repo.storeBatch(
        [
          rec(201, { machineId: "t-12", operatorId: "OP-1", liters: 1 }),
          rec(202, { machineId: "T-12", operatorId: "op-1", liters: 2 }),
        ],
        1,
      );
      const rows = await ctx.repo.consumption({ fromMs: 0, toMs: T0 }, "machine", 0);
      expect(rows.map((r) => r.key).sort()).toEqual(["T-12", "t-12"]);
      const only = await ctx.repo.listTransactions(
        { machineId: "t-12", toMs: T0 },
        {
          limit: 10,
          offset: 0,
        },
      );
      expect(only.items.map((i) => i.sessionId)).toEqual([uuid(201)]);
    });

    it("reports each active device with its session count and last sync", async () => {
      expect(await ctx.repo.deviceStatus()).toEqual([
        { deviceId: "pump-01", tankId: "tank-1", sessions: 4, lastReceivedAtMs: 7000 },
        { deviceId: "pump-02", tankId: "tank-1", sessions: 1, lastReceivedAtMs: 9000 },
        { deviceId: "pump-03", tankId: "tank-2", sessions: 0, lastReceivedAtMs: null },
      ]);
    });

    it("finds a manager by token hash", async () => {
      await ctx.addManager("mgr-1", "manager-token-0123456789abcdef");
      expect(
        await ctx.repo.findManagerByTokenHash(hashToken("manager-token-0123456789abcdef")),
      ).toEqual({ managerId: "mgr-1" });
      expect(
        await ctx.repo.findManagerByTokenHash(hashToken("other-0123456789abcdef")),
      ).toBeUndefined();
    });
  });
}

reportContract("in-memory", async () => {
  const ctx: ReportCtx = {
    repo: new MemoryRepository(),
    reset: async () => {
      ctx.repo = new MemoryRepository();
    },
    addDevice: async (deviceId, tankId) => {
      (ctx.repo as MemoryRepository).addDevice(
        { deviceId, tankId },
        `token-${deviceId}-0123456789`,
      );
    },
    addManager: async (managerId, token) => {
      (ctx.repo as MemoryRepository).addManager(managerId, token);
    },
  };
  return ctx;
});

contract(
  "in-memory",
  async () => {
    let repo = new MemoryRepository();
    const view = { repo } as { repo: SyncRepository };
    return {
      get repo() {
        return view.repo;
      },
      count: async () => repo.all().length,
      reset: async () => {
        repo = new MemoryRepository();
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

/** Empty the append-only table. The delete trigger is dropped for the cleanup and restored. */
async function resetMysql(testUrl: string): Promise<void> {
  const admin = await mysql.createConnection({ uri: testUrl });
  try {
    await admin.query("DROP TRIGGER IF EXISTS transactions_no_delete");
    await admin.query("DELETE FROM transactions");
    await admin.query(
      "CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'transactions are append-only'",
    );
  } finally {
    await admin.end();
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
  const repo = new MysqlRepository(conn.db);

  beforeAll(async () => {
    const admin = await mysql.createConnection({ uri: testUrl });
    await admin.query("DROP TABLE IF EXISTS transactions, devices, managers, __drizzle_migrations");
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

  it("issues tokens that authenticate, and rotating one revokes the old", async () => {
    const first = await issueDeviceToken(conn.db, { deviceId: "pump-77", tankId: "tank-7" }, 1);
    expect(await repo.findDeviceByTokenHash(hashToken(first))).toEqual({
      deviceId: "pump-77",
      tankId: "tank-7",
    });
    const second = await issueDeviceToken(conn.db, { deviceId: "pump-77", tankId: "tank-7" }, 2);
    expect(second).not.toBe(first);
    expect(await repo.findDeviceByTokenHash(hashToken(first))).toBeUndefined();
    expect(await repo.findDeviceByTokenHash(hashToken(second))).toBeDefined();

    const manager = await issueManagerToken(conn.db, { managerId: "mgr-77" }, 1);
    expect(await repo.findManagerByTokenHash(hashToken(manager))).toEqual({ managerId: "mgr-77" });
    await expect(issueManagerToken(conn.db, { managerId: "bad id" }, 1)).rejects.toThrow();
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
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

  reportContract("mysql", async () => ({
    repo,
    reset: async () => {
      await resetMysql(testUrl);
      await conn.db.delete(devices);
      await conn.db.delete(managers);
    },
    addDevice: async (deviceId, tankId) => {
      await conn.db.insert(devices).values({
        deviceId,
        tankId,
        tokenHash: hashToken(`token-${deviceId}-0123456789`),
        createdAtMs: 1,
      });
    },
    addManager: async (managerId, token) => {
      await conn.db
        .insert(managers)
        .values({ managerId, tokenHash: hashToken(token), createdAtMs: 1 });
    },
  }));

  contract(
    "mysql",
    async () => ({
      repo,
      count: async () => (await conn.db.select().from(transactions)).length,
      reset: () => resetMysql(testUrl),
    }),
    15,
  );
});
