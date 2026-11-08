import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { SessionRecord } from "@agriflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimulatedHardware } from "../apps/controller/src/hardware/simulator.ts";
import { createUidHasher } from "../apps/controller/src/service/credentials.ts";
import { DispensingService } from "../apps/controller/src/service/dispensing-service.ts";
import { openDatabase } from "../apps/controller/src/storage/database.ts";
import { ControllerStore } from "../apps/controller/src/storage/store.ts";
import { backupController } from "./backup.ts";
import { enrollFob } from "./enroll-fob.ts";
import { readHiddenLine } from "./lib.ts";
import { DEMO_FOBS, historyRecords, seedController } from "./seed.ts";

const hash = createUidHasher("test-salt-0123456789");
let dir: string;
let db: ReturnType<typeof openDatabase>;
let store: ControllerStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agriflow-scripts-"));
  db = openDatabase(join(dir, "controller.db"));
  store = new ControllerStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("enrollFob", () => {
  const base = { uid: "04A1B2C3", operatorId: "op-0007", machines: "all" } as const;

  it("stores only the hash of the UID", () => {
    const credential = enrollFob(store, hash, base, 1000);
    expect(credential.credentialRef).toBe(hash("04A1B2C3"));
    expect(JSON.stringify(store.findCredential(credential.credentialRef))).not.toContain(
      "04A1B2C3",
    );
    expect(credential).toMatchObject({
      operatorId: "op-0007",
      machineAccess: "all",
      revoked: false,
    });
    expect(credential.expiresAtMs).toBeNull();
  });

  it("supports a machine list and an expiry", () => {
    const credential = enrollFob(
      store,
      hash,
      { ...base, machines: ["m-t12"], expiresInDays: 2 },
      1000,
    );
    expect(credential.machineAccess).toEqual(["m-t12"]);
    expect(credential.expiresAtMs).toBe(1000 + 2 * 86_400_000);
  });

  it("refuses to move a fob to another operator unless asked", () => {
    enrollFob(store, hash, base, 1000);
    expect(() => enrollFob(store, hash, { ...base, operatorId: "op-0099" }, 1000)).toThrow(
      /already belongs to op-0007/,
    );
    const moved = enrollFob(store, hash, { ...base, operatorId: "op-0099", reassign: true }, 1000);
    expect(moved.operatorId).toBe("op-0099");
  });

  it("revokes an enrolled fob and rejects unknown ones", () => {
    expect(() => enrollFob(store, hash, { ...base, revoke: true }, 1000)).toThrow(/not enrolled/);
    enrollFob(store, hash, base, 1000);
    enrollFob(store, hash, { ...base, revoke: true }, 2000);
    expect(store.findCredential(hash("04A1B2C3"))?.revoked).toBe(true);
  });

  it("rejects an empty read and invalid operator ids", () => {
    expect(() => enrollFob(store, hash, { ...base, uid: "  " }, 1000)).toThrow(/no fob UID/);
    expect(() => enrollFob(store, hash, { ...base, operatorId: "Jane Doe" }, 1000)).toThrow();
  });
});

describe("seed", () => {
  it("makes the reference scenario work: op-0007 refuels tractor T-12 offline", () => {
    seedController(store, hash);
    let now = 1_000_000;
    const hardware = new SimulatedHardware({ flowLitersPerMinute: 60, pulsesPerLiter: 100 });
    const service = new DispensingService({
      store,
      hardware,
      deviceId: "pump-01",
      tankId: "tank-1",
      now: () => now,
      hashUid: hash,
    });
    service.boot();
    service.handleScan(DEMO_FOBS["op-0007"]);
    service.selectMachine("T-12");
    service.start();
    for (let t = 0; t < 84_300; t += 100) {
      now += 100;
      hardware.advance(100);
      service.tick();
    }
    service.stop();
    const [session] = store.listSessions();
    expect(session?.operatorId).toBe("op-0007");
    expect(session?.liters).toBeCloseTo(84.3, 3);
    expect(store.listOutbox().map((e) => e.status)).toEqual(["pending"]);
  });

  it("restricts op-0012 to its machines", () => {
    seedController(store, hash);
    expect(store.findCredential(hash(DEMO_FOBS["op-0012"]))?.machineAccess).toEqual([
      "m-t12",
      "m-h03",
    ]);
  });

  it("generates valid, deterministic, unique history", () => {
    const now = Date.UTC(2026, 5, 1, 12);
    const a = historyRecords("pump-01", "tank-1", now, 30);
    expect(a.length).toBeGreaterThan(60);
    expect(new Set(a.map((r) => r.sessionId)).size).toBe(a.length);
    for (const r of a) expect(SessionRecord.safeParse(r).success).toBe(true);
    expect(a.every((r) => r.endedAtMs >= r.startedAtMs && r.startedAtMs < now)).toBe(true);
  });

  it("never reuses an ID for different content, across days and devices", () => {
    const now = Date.UTC(2026, 5, 1, 12);
    const today = historyRecords("pump-01", "tank-1", now, 30);
    const later = historyRecords("pump-01", "tank-1", now + 3 * 86_400_000, 30);
    const other = historyRecords("pump-02", "tank-1", now, 30);
    const byId = new Map(today.map((r) => [r.sessionId, r]));
    // Overlapping days are identical records, so a re-seed is a harmless duplicate.
    const shared = later.filter((r) => byId.has(r.sessionId));
    expect(shared.length).toBeGreaterThan(30);
    for (const r of shared) expect(r).toEqual(byId.get(r.sessionId));
    // Another device shares no IDs at all.
    expect(other.some((r) => byId.has(r.sessionId))).toBe(false);
    // The same device on another tank also gets its own IDs.
    const otherTank = historyRecords("pump-01", "tank-2", now, 30);
    expect(otherTank.some((r) => byId.has(r.sessionId))).toBe(false);
  });
});

describe("backupController", () => {
  it("writes a verified online backup and keeps only the newest ones", async () => {
    seedController(store, hash);
    const out = join(dir, "backups");
    await backupController(db, out, new Date("2026-06-01T10:00:00Z"), 2);
    await backupController(db, out, new Date("2026-06-02T10:00:00Z"), 2);
    const last = await backupController(db, out, new Date("2026-06-03T10:00:00Z"), 2);
    expect(readdirSync(out).sort()).toEqual([
      "controller-20260602-100000.db",
      "controller-20260603-100000.db",
    ]);
    const copy = openDatabase(last);
    expect(new ControllerStore(copy).findMachineByEquipmentNumber("T-12")).toBeDefined();
    copy.close();
  });
});

describe("readHiddenLine", () => {
  it("returns the first piped line and never writes it back out", async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const pending = readHiddenLine(input, (text) => written.push(text));
    input.write("04A1B2C3\nsecond\n");
    expect(await pending).toBe("04A1B2C3");
    expect(written.join("")).not.toContain("04A1B2C3");
  });

  it("fails when the input ends without a line", async () => {
    const input = new PassThrough();
    const pending = readHiddenLine(input, () => undefined);
    input.end();
    await expect(pending).rejects.toThrow(/no input/);
  });
});
