import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimulatedHardware } from "../hardware/simulator.ts";
import { openDatabase } from "../storage/database.ts";
import { ControllerStore } from "../storage/store.ts";
import { DispensingService } from "./dispensing-service.ts";
import { ControllerRuntime } from "./runtime.ts";

const FOB = "04A1B2C3";
let dir: string;
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agriflow-rt-"));
  db = openDatabase(join(dir, "c.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ControllerRuntime", () => {
  it("records the final liters of an active session on stop, before the next checkpoint", () => {
    const store = new ControllerStore(db);
    store.upsertMachine({ machineId: "m1", equipmentNumber: "T-12", active: true } as never);
    store.upsertCredential({
      credentialRef: "a".repeat(64),
      operatorId: "op-0007",
      machineAccess: "all",
      expiresAtMs: null,
      revoked: false,
    } as never);
    let now = 1_000_000;
    const hardware = new SimulatedHardware({ flowLitersPerMinute: 60, pulsesPerLiter: 100 });
    const service = new DispensingService({
      store,
      hardware,
      deviceId: "pump-01",
      tankId: "tank-1",
      now: () => now,
      hashUid: () => "a".repeat(64),
    });
    const runtime = new ControllerRuntime({ service, hardware });
    runtime.start();
    hardware.scan(FOB);
    runtime.run(() => service.selectMachine("T-12"));
    runtime.run(() => service.start());
    expect(hardware.relay.isEnabled()).toBe(true);

    // One liter flows, less than the checkpoint interval has elapsed.
    now += 1000;
    hardware.advance(1000);
    runtime.stop();

    expect(hardware.relay.isEnabled()).toBe(false);
    const [session] = store.listSessions();
    expect(session?.liters).toBeCloseTo(1, 5);
    expect(store.findOpenSession()).toBeNull();
  });

  it("leaves the pump off and stays idle when stopped without a session", () => {
    const store = new ControllerStore(db);
    const hardware = new SimulatedHardware();
    const service = new DispensingService({
      store,
      hardware,
      deviceId: "pump-01",
      tankId: "tank-1",
      now: () => 1,
      hashUid: () => "a".repeat(64),
    });
    const runtime = new ControllerRuntime({ service, hardware });
    runtime.start();
    runtime.stop();
    expect(hardware.relay.isEnabled()).toBe(false);
    expect(store.listSessions()).toEqual([]);
  });

  it("keeps liters delivered since the last tick when a fault ends the session", () => {
    const store = new ControllerStore(db);
    store.upsertMachine({ machineId: "m1", equipmentNumber: "T-12", active: true } as never);
    store.upsertCredential({
      credentialRef: "a".repeat(64),
      operatorId: "op-0007",
      machineAccess: "all",
      expiresAtMs: null,
      revoked: false,
    } as never);
    let now = 1_000_000;
    const hardware = new SimulatedHardware({ flowLitersPerMinute: 60, pulsesPerLiter: 100 });
    const service = new DispensingService({
      store,
      hardware,
      deviceId: "pump-01",
      tankId: "tank-1",
      now: () => now,
      hashUid: () => "a".repeat(64),
    });
    const runtime = new ControllerRuntime({ service, hardware, onError: () => undefined });
    runtime.start();
    hardware.scan(FOB);
    runtime.run(() => service.selectMachine("T-12"));
    runtime.run(() => service.start());
    now += 1000;
    hardware.advance(1000);
    runtime.run(() => {
      throw new Error("boom");
    });
    expect(hardware.relay.isEnabled()).toBe(false);
    expect(store.listSessions()[0]?.liters).toBeCloseTo(1, 5);
    runtime.stop();
  });

  it("switches the pump off when the hardware status cannot be read", () => {
    const store = new ControllerStore(db);
    const hardware = new SimulatedHardware();
    const service = new DispensingService({
      store,
      hardware,
      deviceId: "pump-01",
      tankId: "tank-1",
      now: () => 1,
      hashUid: () => "a".repeat(64),
    });
    const errors: unknown[] = [];
    const runtime = new ControllerRuntime({ service, hardware, onError: (e) => errors.push(e) });
    runtime.start();
    hardware.relay.enable();
    hardware.estop.isEngaged = () => {
      throw new Error("gpio read failed");
    };
    runtime.run(() => undefined);
    expect(hardware.relay.isEnabled()).toBe(false);
    expect(errors).toHaveLength(1);
    runtime.stop();
  });

  it("drops a pending authorization on a fault and rejects commands after stop", () => {
    const store = new ControllerStore(db);
    store.upsertMachine({ machineId: "m1", equipmentNumber: "T-12", active: true } as never);
    store.upsertCredential({
      credentialRef: "a".repeat(64),
      operatorId: "op-0007",
      machineAccess: "all",
      expiresAtMs: null,
      revoked: false,
    } as never);
    const hardware = new SimulatedHardware();
    const service = new DispensingService({
      store,
      hardware,
      deviceId: "pump-01",
      tankId: "tank-1",
      now: () => 1_000_000,
      hashUid: () => "a".repeat(64),
    });
    const runtime = new ControllerRuntime({ service, hardware, onError: () => undefined });
    runtime.start();
    hardware.scan(FOB);
    runtime.run(() => service.selectMachine("T-12"));
    expect(service.snapshot().phase).toBe("authorized");

    runtime.run(() => {
      throw new Error("boom");
    });
    expect(service.snapshot().phase).toBe("idle");
    runtime.run(() => service.start());
    expect(hardware.relay.isEnabled()).toBe(false);

    runtime.stop();
    hardware.scan(FOB);
    runtime.run(() => service.selectMachine("T-12"));
    runtime.run(() => service.start());
    expect(hardware.relay.isEnabled()).toBe(false);
    expect(store.listSessions()).toEqual([]);
  });

  it("rolls back and stays closed when listener registration fails", () => {
    const store = new ControllerStore(db);
    const hardware = new SimulatedHardware();
    hardware.buttons.onPress = () => {
      throw new Error("gpio unavailable");
    };
    const service = new DispensingService({
      store,
      hardware,
      deviceId: "pump-01",
      tankId: "tank-1",
      now: () => 1,
      hashUid: () => "a".repeat(64),
    });
    const runtime = new ControllerRuntime({ service, hardware });
    expect(() => runtime.start()).toThrow("gpio unavailable");
    hardware.scan(FOB);
    expect(service.snapshot().phase).toBe("idle");
    expect(hardware.relay.isEnabled()).toBe(false);
  });

  it("still switches the pump off when a listener cleanup throws", () => {
    const store = new ControllerStore(db);
    const hardware = new SimulatedHardware();
    hardware.estop.onChange = () => () => {
      throw new Error("cleanup failed");
    };
    const service = new DispensingService({
      store,
      hardware,
      deviceId: "pump-01",
      tankId: "tank-1",
      now: () => 1,
      hashUid: () => "a".repeat(64),
    });
    const errors: unknown[] = [];
    const runtime = new ControllerRuntime({ service, hardware, onError: (e) => errors.push(e) });
    runtime.start();
    hardware.relay.enable();
    runtime.stop();
    expect(hardware.relay.isEnabled()).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("reports an incomplete shutdown while the final session cannot be stored, then retries", () => {
    const store = new ControllerStore(db);
    store.upsertMachine({ machineId: "m1", equipmentNumber: "T-12", active: true } as never);
    store.upsertCredential({
      credentialRef: "a".repeat(64),
      operatorId: "op-0007",
      machineAccess: "all",
      expiresAtMs: null,
      revoked: false,
    } as never);
    let now = 1_000_000;
    const hardware = new SimulatedHardware({ flowLitersPerMinute: 60, pulsesPerLiter: 100 });
    const service = new DispensingService({
      store,
      hardware,
      deviceId: "pump-01",
      tankId: "tank-1",
      now: () => now,
      hashUid: () => "a".repeat(64),
    });
    const runtime = new ControllerRuntime({ service, hardware, onError: () => undefined });
    runtime.start();
    hardware.scan(FOB);
    runtime.run(() => service.selectMachine("T-12"));
    runtime.run(() => service.start());
    now += 1000;
    hardware.advance(1000);

    const finalize = store.finalizeSession.bind(store);
    store.finalizeSession = () => {
      throw new Error("disk full");
    };
    expect(() => runtime.stop()).toThrow(/shutdown incomplete/);
    expect(hardware.relay.isEnabled()).toBe(false);
    expect(store.listSessions()).toEqual([]);

    expect(() => runtime.start()).toThrow(/previous session/);

    store.finalizeSession = finalize;
    runtime.stop();
    expect(store.listSessions()[0]?.liters).toBeCloseTo(1, 5);
  });
});
