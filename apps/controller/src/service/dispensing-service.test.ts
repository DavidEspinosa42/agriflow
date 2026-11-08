import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimulatedHardware } from "../hardware/simulator.ts";
import { openDatabase } from "../storage/database.ts";
import { ControllerStore } from "../storage/store.ts";
import { DispensingService } from "./dispensing-service.ts";

const FOB = "04A1B2C3";
const hashUid = (uid: string) => (uid === FOB ? "a".repeat(64) : "f".repeat(64));

let dir: string;
let path: string;
let now: number;
let n: number;

const newId = () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agriflow-svc-"));
  path = join(dir, "controller.db");
  now = 1_000_000;
  n = 1;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(options: { flow?: number } = {}) {
  const db = openDatabase(path);
  const store = new ControllerStore(db);
  store.upsertMachine({ machineId: "m1", equipmentNumber: "T-12", active: true } as never);
  store.upsertMachine({ machineId: "m2", equipmentNumber: "T-99", active: false } as never);
  store.upsertCredential({
    credentialRef: "a".repeat(64),
    operatorId: "op-0007",
    machineAccess: "all",
    expiresAtMs: null,
    revoked: false,
  } as never);
  const hardware = new SimulatedHardware({ flowLitersPerMinute: options.flow ?? 60 });
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
  const run = (seconds: number, stepMs = 500) => {
    for (let t = 0; t < seconds * 1000; t += stepMs) {
      now += stepMs;
      hardware.advance(stepMs);
      service.tick();
    }
  };
  return { db, store, hardware, service, run };
}

function authorizeAndStart(s: ReturnType<typeof setup>) {
  s.service.handleScan(FOB);
  s.service.selectMachine("T-12");
  s.service.start();
}

describe("DispensingService", () => {
  it("keeps the pump off until a valid fob and machine are given (invariant 1)", () => {
    const s = setup();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    s.service.start();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    s.service.handleScan("UNKNOWN");
    expect(s.service.snapshot().notice).toEqual({ kind: "denied", reason: "unknown_credential" });
    s.service.selectMachine("T-12");
    s.service.start();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    s.db.close();
  });

  it("denies unknown and inactive machines and audits the reason without the fob UID", () => {
    const s = setup();
    s.service.handleScan(FOB);
    expect(s.service.selectMachine("NOPE")).toMatchObject({
      allowed: false,
      reason: "unknown_machine",
    });
    s.service.handleScan(FOB);
    expect(s.service.selectMachine("T-99")).toMatchObject({
      allowed: false,
      reason: "machine_inactive",
    });
    const audit = s.store.listAudit().filter((e) => e.kind === "authorization_denied");
    expect(audit.map((e) => e.reason)).toEqual(["unknown_machine", "machine_inactive"]);
    expect(JSON.stringify(s.store.listAudit())).not.toContain(FOB);
    expect(s.hardware.relay.isEnabled()).toBe(false);
    s.db.close();
  });

  it("dispenses, records and finalizes a session on operator stop", () => {
    const s = setup();
    authorizeAndStart(s);
    expect(s.hardware.relay.isEnabled()).toBe(true);
    s.run(10); // 60 L/min for 10 s = 10 L
    expect(s.service.snapshot()).toMatchObject({ phase: "dispensing", operatorId: "op-0007" });
    s.service.stop();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    const [session] = s.store.listSessions();
    expect(session?.liters).toBeCloseTo(10, 1);
    expect(session?.endReason).toBe("operator_stop");
    expect(s.store.listOutbox()).toMatchObject([{ status: "pending" }]);
    expect(s.store.findOpenSession()).toBeNull();
    s.db.close();
  });

  it("checkpoints progress while dispensing", () => {
    const s = setup();
    authorizeAndStart(s);
    s.run(6);
    expect(s.store.findOpenSession()?.liters).toBeGreaterThan(4);
    s.db.close();
  });

  it("stops at the maximum session liters", () => {
    const s = setup({ flow: 120 });
    s.store.setSetting("maxSessionLiters", 5);
    s.service.boot();
    authorizeAndStart(s);
    s.run(10);
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.listSessions()[0]?.endReason).toBe("max_liters");
    s.db.close();
  });

  it("ends the session when no flow is seen for the idle timeout", () => {
    const s = setup({ flow: 60 });
    authorizeAndStart(s);
    s.run(2);
    s.hardware.relay.disable(); // flow stops without an operator action
    s.run(125);
    expect(s.store.listSessions()[0]?.endReason).toBe("idle_timeout");
    s.db.close();
  });

  it("lapses an authorization that is not used in time", () => {
    const s = setup();
    s.service.handleScan(FOB);
    s.service.selectMachine("T-12");
    s.run(61);
    expect(s.service.snapshot()).toMatchObject({ phase: "idle", notice: { kind: "lapsed" } });
    s.service.start();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    s.db.close();
  });

  it("disables the pump and records an estop session when the E-stop engages", () => {
    const s = setup();
    authorizeAndStart(s);
    s.run(4);
    s.hardware.engageEstop();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.listSessions()[0]?.endReason).toBe("estop");
    s.service.dismiss();
    s.hardware.releaseEstop();
    s.run(2);
    expect(s.hardware.relay.isEnabled()).toBe(false);
    s.db.close();
  });

  it("refuses to start while the E-stop is engaged", () => {
    const s = setup();
    s.service.handleScan(FOB);
    s.service.selectMachine("T-12");
    s.hardware.engageEstop();
    s.service.start();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.listSessions()).toEqual([]);
    s.db.close();
  });

  it("faults on an implausible flow burst", () => {
    const s = setup({ flow: 60 });
    authorizeAndStart(s);
    s.run(2);
    // 100 L in one tick is far above the plausible rate.
    now += 500;
    s.hardware.relay.disable();
    (s.hardware as unknown as { advance: (ms: number) => void }).advance(0);
    const hw = s.hardware as SimulatedHardware;
    hw.relay.enable();
    hw.advance(60_000);
    s.service.tick();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.listSessions()[0]?.endReason).toBe("fault");
    expect(s.store.listSessions()[0]?.liters).toBeLessThan(5);
    s.db.close();
  });

  it("counts pulses delivered between ticks when the operator stops (invariant 2)", () => {
    const s = setup();
    authorizeAndStart(s);
    now += 500;
    s.hardware.advance(500); // 0.5 L, no tick yet
    s.service.stop();
    expect(s.store.listSessions()[0]?.liters).toBeCloseTo(0.5, 2);
    s.db.close();
  });

  it("counts pulses delivered before an E-stop that arrives between ticks", () => {
    const s = setup();
    authorizeAndStart(s);
    now += 500;
    s.hardware.advance(500);
    s.hardware.engageEstop();
    expect(s.store.listSessions()[0]).toMatchObject({ endReason: "estop" });
    expect(s.store.listSessions()[0]?.liters).toBeCloseTo(0.5, 2);
    s.db.close();
  });

  it("keeps a session whose write failed and retries until it is recorded", () => {
    const s = setup();
    authorizeAndStart(s);
    s.run(4);
    const original = s.store.finalizeSession.bind(s.store);
    s.store.finalizeSession = () => {
      throw new Error("disk full");
    };
    s.service.stop();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.service.snapshot().notice).toEqual({ kind: "fault", reason: "storage_failure" });
    expect(s.store.listSessions()).toEqual([]);
    s.service.dismiss();
    expect(s.service.snapshot().phase).toBe("finished");
    s.service.handleScan(FOB);
    expect(s.service.snapshot().phase).toBe("finished");
    s.store.finalizeSession = original;
    s.service.tick();
    expect(s.store.listSessions()).toHaveLength(1);
    expect(s.store.listSessions()[0]?.liters).toBeCloseTo(4, 1);
    expect(s.store.listOutbox()).toHaveLength(1);
    s.service.dismiss();
    expect(s.service.snapshot().phase).toBe("idle");
    s.db.close();
  });

  it("measures the authorization window from fob presentation", () => {
    const s = setup();
    s.service.handleScan(FOB);
    now += 59_000;
    s.service.selectMachine("T-12");
    now += 1_500; // 60.5 s after the scan
    s.service.start();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.listSessions()).toEqual([]);
    s.db.close();
  });

  it("does not start the pump if authorization expires during the checkpoint write", () => {
    const s = setup();
    s.service.handleScan(FOB);
    s.service.selectMachine("T-12");
    now += 59_500;
    const original = s.store.checkpoint.bind(s.store);
    s.store.checkpoint = (open) => {
      original(open);
      now += 1_000; // slow commit pushes the clock past the deadline
    };
    s.service.start();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.findOpenSession()).toBeNull();
    expect(s.service.snapshot()).toMatchObject({ phase: "idle", notice: { kind: "lapsed" } });
    s.db.close();
  });

  it("does not record an implausible burst that arrives between ticks before a stop", () => {
    const s = setup();
    authorizeAndStart(s);
    s.run(2);
    now += 500;
    s.hardware.advance(60_000); // 60 L reported within 500 ms
    s.service.stop();
    const [session] = s.store.listSessions();
    expect(session?.endReason).toBe("fault");
    expect(session?.liters).toBeLessThan(5);
    s.db.close();
  });

  it("turns the pump off when the meter cannot be read", () => {
    const s = setup();
    authorizeAndStart(s);
    s.run(2);
    (s.hardware.meter as { readPulses: () => number }).readPulses = () => {
      throw new Error("sensor offline");
    };
    now += 500;
    expect(() => s.service.tick()).toThrow("sensor offline");
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.listSessions()[0]?.endReason).toBe("fault");
    s.db.close();
  });

  it("does not mistake one legitimate pulse in a very short interval for a burst", () => {
    const s = setup();
    authorizeAndStart(s);
    now += 29;
    s.hardware.advance(29);
    s.service.tick();
    now += 1;
    s.hardware.advance(1);
    s.service.stop();
    const [session] = s.store.listSessions();
    expect(session?.endReason).toBe("operator_stop");
    expect(session?.liters).toBeGreaterThan(0);
    s.db.close();
  });

  it("does not start if reading the meter pushes the clock past the authorization deadline", () => {
    const s = setup();
    s.service.handleScan(FOB);
    s.service.selectMachine("T-12");
    now += 59_999;
    const hw = s.hardware as unknown as { meter: { readPulses: () => number } };
    const read = hw.meter.readPulses;
    hw.meter.readPulses = () => {
      now += 2;
      return read();
    };
    s.service.start();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.findOpenSession()).toBeNull();
    s.db.close();
  });

  it("detects sustained excessive flow even with very short ticks", () => {
    const s = setup({ flow: 600 });
    authorizeAndStart(s);
    for (let i = 0; i < 3000 && s.hardware.relay.isEnabled(); i++) {
      now += 1;
      s.hardware.advance(1);
      s.service.tick();
    }
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.listSessions()[0]?.endReason).toBe("fault");
    expect(s.store.listSessions()[0]?.liters).toBeLessThan(5);
    s.db.close();
  });

  it("refuses to start when the meter baseline is not a valid counter", () => {
    const s = setup();
    s.service.handleScan(FOB);
    s.service.selectMachine("T-12");
    (s.hardware.meter as { readPulses: () => number }).readPulses = () => Number.NaN;
    s.service.start();
    expect(s.hardware.relay.isEnabled()).toBe(false);
    expect(s.store.findOpenSession()).toBeNull();
    expect(s.service.snapshot().notice).toEqual({ kind: "fault", reason: "meter_unreadable" });
    s.db.close();
  });

  it("rejects invalid device or tank ids at construction", () => {
    const s = setup();
    const base = {
      store: s.store,
      hardware: s.hardware,
      now: () => now,
      hashUid,
    };
    expect(() => new DispensingService({ ...base, deviceId: "", tankId: "tank-1" })).toThrow();
    expect(
      () => new DispensingService({ ...base, deviceId: "pump-01", tankId: "bad id" }),
    ).toThrow();
    s.db.close();
  });

  it("recovers after a power cut: pump off, session closed as interrupted, never resumed", () => {
    const first = setup();
    authorizeAndStart(first);
    first.run(6);
    const checkpointed = first.store.findOpenSession()?.liters ?? 0;
    first.db.close(); // power cut: no stop, no finalize

    now += 30_000;
    const second = setup();
    expect(second.hardware.relay.isEnabled()).toBe(false);
    const [session] = second.store.listSessions();
    expect(session?.endReason).toBe("interrupted");
    expect(session?.liters).toBeCloseTo(checkpointed, 6);
    expect(second.store.findOpenSession()).toBeNull();
    expect(second.store.listOutbox()).toMatchObject([{ status: "pending" }]);
    expect(second.service.snapshot().phase).toBe("idle");
    second.db.close();
  });
});
