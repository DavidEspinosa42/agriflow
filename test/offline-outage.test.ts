import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRecord } from "@agriflow/core";
import mysql from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SimulatedHardware } from "../apps/controller/src/hardware/simulator.ts";
import { type Fetch, SyncWorker } from "../apps/controller/src/net/sync-worker.ts";
import { createUidHasher } from "../apps/controller/src/service/credentials.ts";
import { DispensingService } from "../apps/controller/src/service/dispensing-service.ts";
import { openDatabase } from "../apps/controller/src/storage/database.ts";
import { ControllerStore } from "../apps/controller/src/storage/store.ts";
import { connect, runMigrations } from "../apps/server/src/db/connection.ts";
import { MysqlRepository } from "../apps/server/src/db/mysql-repository.ts";
import { MemoryRepository } from "../apps/server/src/db/repository.ts";
import { buildApp } from "../apps/server/src/http/app.ts";
import { DEMO_FOBS, seedController } from "../scripts/seed.ts";

/**
 * The reference scenario from docs/domain.md, end to end: an operator refuels a tractor while
 * the farm has no internet, the session is stored locally and uploaded when the link returns,
 * and replays never create a second central transaction.
 */

const SALT = "e2e-salt-0123456789";
const hashUid = createUidHasher(SALT);
const DEVICE_TOKEN = "e2e-device-token-0123456789abcdef";
const MANAGER_TOKEN = "e2e-manager-token-0123456789abcdef";

interface Backend {
  repo: MemoryRepository | MysqlRepository;
  /** Make the server reachable under the device and manager tokens above. */
  register(): Promise<void>;
  count(): Promise<number>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

function memoryBackend(): Backend {
  let repo = new MemoryRepository();
  const backend: Backend = {
    get repo() {
      return repo;
    },
    register: async () => {
      repo.addDevice({ deviceId: "pump-01", tankId: "tank-1" }, DEVICE_TOKEN);
      repo.addManager("mgr-1", MANAGER_TOKEN);
    },
    count: async () => repo.all().length,
    reset: async () => {
      repo = new MemoryRepository();
    },
    close: async () => undefined,
  };
  return backend;
}

function mysqlBackend(url: string): Backend {
  const conn = connect(url);
  const repo = new MysqlRepository(conn.db);
  const admin = async <T>(work: (c: mysql.Connection) => Promise<T>) => {
    const c = await mysql.createConnection({ uri: url });
    try {
      return await work(c);
    } finally {
      await c.end();
    }
  };
  return {
    repo,
    register: async () => {
      // Rotating a token replaces the previous one, so register fixed tokens by hash instead.
      const { hashToken } = await import("../apps/server/src/db/repository.ts");
      await admin(async (c) => {
        await c.query(
          "INSERT INTO devices (device_id, tank_id, token_hash, revoked, created_at_ms) VALUES ('pump-01','tank-1',?,0,1)",
          [hashToken(DEVICE_TOKEN)],
        );
        await c.query(
          "INSERT INTO managers (manager_id, token_hash, revoked, created_at_ms) VALUES ('mgr-1',?,0,1)",
          [hashToken(MANAGER_TOKEN)],
        );
      });
    },
    count: async () =>
      admin(async (c) => {
        const [rows] = await c.query("SELECT COUNT(*) AS n FROM transactions");
        return Number((rows as { n: number }[])[0]?.n);
      }),
    reset: async () =>
      admin(async (c) => {
        await c.query("DROP TRIGGER IF EXISTS transactions_no_delete");
        await c.query("DELETE FROM transactions");
        await c.query("DELETE FROM devices");
        await c.query("DELETE FROM managers");
        await c.query(
          "CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'transactions are append-only'",
        );
      }),
    close: () => conn.close(),
  };
}

function scenarios(name: string, makeBackend: () => Backend, prepare?: () => Promise<void>) {
  describe(`offline outage (${name})`, () => {
    const backend = makeBackend();
    let dir: string;
    let now: number;
    let online: boolean;
    let sequence: number;

    beforeAll(async () => {
      await prepare?.();
    });

    afterAll(async () => {
      await backend.close();
    });

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "agriflow-e2e-"));
      now = Date.UTC(2026, 2, 9, 12, 0, 0);
      online = false;
      sequence = 1;
      await backend.reset();
      await backend.register();
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const newId = () => `e2e00000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;

    /** The controller side: a database file, a simulated pump and the service on top. */
    function controller() {
      const db = openDatabase(join(dir, "controller.db"));
      const store = new ControllerStore(db);
      seedController(store, hashUid);
      const hardware = new SimulatedHardware({ flowLitersPerMinute: 60, pulsesPerLiter: 100 });
      const service = new DispensingService({
        store,
        hardware,
        deviceId: "pump-01",
        tankId: "tank-1",
        now: () => now,
        hashUid,
        newId,
      });
      service.boot();
      hardware.estop.onChange((engaged) => service.handleEstop(engaged));
      const run = (ms: number) => {
        for (let t = 0; t < ms; t += 100) {
          now += 100;
          hardware.advance(100);
          service.tick();
        }
      };
      return { db, store, hardware, service, run };
    }

    /** The network between controller and server: down during the outage. */
    function network(): Fetch {
      const app = buildApp({ repository: backend.repo, now: () => now });
      return async (url, init) => {
        if (!online) throw new TypeError("fetch failed: no route to host");
        const res = await app.inject({
          method: "POST",
          url: new URL(url).pathname,
          headers: init.headers as Record<string, string>,
          payload: init.body as string,
        });
        return new Response(res.body, { status: res.statusCode });
      };
    }

    const worker = (store: ControllerStore, fetch: Fetch) =>
      new SyncWorker({
        store,
        deviceId: "pump-01",
        serverUrl: "http://farm-server.test",
        token: DEVICE_TOKEN,
        now: () => now,
        random: () => 0.5,
        fetch,
      });

    function refuel(c: ReturnType<typeof controller>, seconds: number) {
      c.service.handleScan(DEMO_FOBS["op-0007"]);
      c.service.selectMachine("T-12");
      c.service.start();
      c.run(seconds * 1000);
      c.service.stop();
      c.service.dismiss();
    }

    it("stores the refueling locally, uploads it on reconnect, and never duplicates it", async () => {
      const c = controller();
      const sync = worker(c.store, network());

      // 1. No internet. The operator refuels the tractor: 84.3 L at 60 L/min.
      refuel(c, 84.3);
      expect(c.hardware.relay.isEnabled()).toBe(false);
      const [session] = c.store.listSessions();
      expect(session).toMatchObject({
        operatorId: "op-0007",
        machineId: "m-t12",
        endReason: "operator_stop",
      });
      expect(session?.liters).toBeCloseTo(84.3, 3);
      expect(c.store.listOutbox().map((e) => e.status)).toEqual(["pending"]);

      // 2. The upload fails while offline; the session stays pending and a retry is scheduled.
      expect(await sync.runOnce()).toMatchObject({ kind: "failed", reason: "network" });
      expect(c.store.listOutbox().map((e) => e.status)).toEqual(["pending"]);
      expect(await backend.count()).toBe(0);
      expect(await sync.runOnce()).toEqual({ kind: "idle" }); // backing off

      // 3. Connectivity returns. The next attempt uploads it and the server acknowledges.
      online = true;
      now += 10 * 60_000;
      expect(await sync.runOnce()).toEqual({ kind: "synced", sent: 1, acked: 1 });
      expect(c.store.listOutbox().map((e) => e.status)).toEqual(["acked"]);
      expect(await backend.count()).toBe(1);

      // 4. Replays change nothing: another worker run, and the same batch sent again by hand.
      expect(await sync.runOnce()).toEqual({ kind: "idle" });
      const again = await backend.repo.storeBatch([SessionRecord.parse(session)], now);
      expect(again.map((a) => a.status)).toEqual(["duplicate"]);
      expect(await backend.count()).toBe(1);

      // 5. The manager sees exactly one transaction of 84.3 L.
      const app = buildApp({ repository: backend.repo, now: () => now });
      const report = await app.inject({
        method: "GET",
        url: "/v1/transactions",
        headers: { authorization: `Bearer ${MANAGER_TOKEN}` },
      });
      expect(report.json().total).toBe(1);
      expect(report.json().items[0].liters).toBeCloseTo(84.3, 3);
      c.db.close();
    });

    it("survives a crash mid-dispense: pump off, interrupted session recorded and synced", async () => {
      const first = controller();
      first.service.handleScan(DEMO_FOBS["op-0007"]);
      first.service.selectMachine("T-12");
      first.service.start();
      first.run(10_000); // 10 L, with checkpoints along the way
      expect(first.hardware.relay.isEnabled()).toBe(true);
      // Power is lost: the process dies without stopping anything and the database is left as is.
      first.db.close();

      const second = controller(); // the controller restarts
      expect(second.hardware.relay.isEnabled()).toBe(false);
      const [recovered] = second.store.listSessions();
      expect(recovered?.endReason).toBe("interrupted");
      expect(recovered?.liters).toBeGreaterThan(7);
      expect(recovered?.liters).toBeLessThanOrEqual(10);
      expect(second.service.snapshot()).toMatchObject({ phase: "idle", pumpOn: false });
      // Restarting alone never resumes dispensing.
      second.run(5000);
      expect(second.hardware.relay.isEnabled()).toBe(false);

      online = true;
      const sync = worker(second.store, network());
      expect(await sync.runOnce()).toEqual({ kind: "synced", sent: 1, acked: 1 });
      expect(await backend.count()).toBe(1);
      second.db.close();
    });

    it("keeps pending sessions across controller restarts and uploads them in order", async () => {
      const a = controller();
      refuel(a, 5);
      refuel(a, 8);
      a.db.close();

      const b = controller();
      expect(b.store.listOutbox().map((e) => e.status)).toEqual(["pending", "pending"]);
      online = true;
      const sync = worker(b.store, network());
      expect(await sync.runOnce()).toEqual({ kind: "synced", sent: 2, acked: 2 });
      expect(await backend.count()).toBe(2);
      b.db.close();
    });
  });
}

scenarios("in-memory server", memoryBackend);

const e2eUrl = process.env["MYSQL_E2E_URL"];
if (e2eUrl !== undefined) {
  // A database of its own, so it cannot collide with the repository tests that drop tables.
  const safe = /^mysql:\/\/[^/]+\/[A-Za-z0-9_]*_e2e_test$/.test(e2eUrl);
  describe("mysql e2e configuration", () => {
    it("requires a database whose name ends in _e2e_test", () => {
      expect(safe).toBe(true);
    });
  });
  if (safe) {
    scenarios(
      "mysql server",
      () => mysqlBackend(e2eUrl),
      async () => {
        const admin = await mysql.createConnection({ uri: e2eUrl });
        await admin.query(
          "DROP TABLE IF EXISTS transactions, devices, managers, __drizzle_migrations",
        );
        await admin.end();
        await runMigrations(e2eUrl);
      },
    );
  }
}
