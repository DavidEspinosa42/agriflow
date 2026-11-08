import { describe, expect, it } from "vitest";
import {
  ClientCommand,
  ServerMessage,
  type Snapshot,
  SnapshotSchema,
} from "./operator-protocol.ts";

const idle: Snapshot = {
  phase: "idle",
  pumpOn: false,
  estopEngaged: false,
  operatorId: null,
  machineId: null,
  liters: 0,
  endReason: null,
  notice: { kind: "none" },
};

describe("operator protocol", () => {
  it("accepts every notice and phase the controller can produce", () => {
    for (const notice of [
      { kind: "none" },
      { kind: "denied", reason: "machine_not_permitted" },
      { kind: "lapsed" },
      { kind: "fault", reason: "estop_engaged" },
    ]) {
      expect(SnapshotSchema.safeParse({ ...idle, notice }).success).toBe(true);
    }
    for (const phase of ["idle", "awaiting_machine", "authorized", "dispensing", "finished"]) {
      expect(SnapshotSchema.safeParse({ ...idle, phase }).success).toBe(true);
    }
  });

  it("rejects malformed snapshots and anything that could carry a fob UID", () => {
    expect(SnapshotSchema.safeParse({ ...idle, liters: -1 }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...idle, phase: "paused" }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...idle, uid: "04A1B2C3" }).success).toBe(false);
    expect(
      SnapshotSchema.safeParse({ ...idle, notice: { kind: "denied", reason: "x" } }).success,
    ).toBe(false);
  });

  it("allows only the operator commands and never a scan", () => {
    expect(
      ClientCommand.safeParse({ type: "select_machine", equipmentNumber: "T-12" }).success,
    ).toBe(true);
    expect(ClientCommand.safeParse({ type: "start" }).success).toBe(true);
    expect(ClientCommand.safeParse({ type: "scan", uid: "04A1B2C3" }).success).toBe(false);
    expect(ClientCommand.safeParse({ type: "start", extra: 1 }).success).toBe(false);
    expect(ClientCommand.safeParse({ type: "select_machine", equipmentNumber: "" }).success).toBe(
      false,
    );
  });

  it("parses server messages", () => {
    expect(ServerMessage.safeParse({ type: "state", snapshot: idle }).success).toBe(true);
    expect(ServerMessage.safeParse({ type: "error", error: "invalid_json" }).success).toBe(true);
    expect(ServerMessage.safeParse({ type: "error", error: "boom" }).success).toBe(false);
  });
});
