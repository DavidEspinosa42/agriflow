import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import type { Credential, Machine, SessionRecord } from "@agriflow/core";
import { createUidHasher } from "../apps/controller/src/service/credentials.ts";
import { openDatabase } from "../apps/controller/src/storage/database.ts";
import { ControllerStore } from "../apps/controller/src/storage/store.ts";
import { connect } from "../apps/server/src/db/connection.ts";
import { MysqlRepository } from "../apps/server/src/db/mysql-repository.ts";
import { issueDeviceToken, issueManagerToken } from "../apps/server/src/db/tokens.ts";
import { controllerDbPath, requireEnv, runCli } from "./lib.ts";

/**
 * Dummy fob UIDs for the simulator demo. They are not real credentials and exist only so the
 * reference scenario in docs/domain.md can be replayed with `/dev/scan`.
 */
export const DEMO_FOBS = {
  "op-0007": "04A1B2C3",
  "op-0012": "04D4E5F6",
  "op-0031": "04070809",
} as const;

export const DEMO_MACHINES = [
  { machineId: "m-t12", equipmentNumber: "T-12", active: true },
  { machineId: "m-h03", equipmentNumber: "H-03", active: true },
  { machineId: "m-s07", equipmentNumber: "S-07", active: true },
  { machineId: "m-c01", equipmentNumber: "C-01", active: false },
] as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Small deterministic PRNG so the same seed always produces the same history. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed the controller with demo machines and operator fobs. */
export function seedController(store: ControllerStore, hashUid: (uid: string) => string): void {
  for (const machine of DEMO_MACHINES) store.upsertMachine(machine as unknown as Machine);
  const access: Record<string, Credential["machineAccess"]> = {
    "op-0007": "all",
    "op-0012": ["m-t12", "m-h03"] as unknown as Credential["machineAccess"],
    "op-0031": "all",
  };
  for (const [operatorId, uid] of Object.entries(DEMO_FOBS)) {
    store.upsertCredential({
      credentialRef: hashUid(uid),
      operatorId,
      machineAccess: access[operatorId] ?? "all",
      expiresAtMs: null,
      revoked: false,
    } as unknown as Credential);
  }
}

const REASONS = ["operator_stop", "operator_stop", "operator_stop", "idle_timeout", "max_liters"];

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A stable, valid UUID derived from a key, so the same dummy session always gets the same ID. */
export function uuidFrom(key: string): string {
  const h = digest(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Deterministic dummy sessions for the `days` days before today, for dashboards and screenshots.
 * Each session depends only on its device, calendar day and position in the day, so seeding again
 * (even on a later day or for another device) never produces the same ID with different content.
 */
export function historyRecords(
  deviceId: string,
  tankId: string,
  nowMs: number,
  days: number,
  seed = 7,
): SessionRecord[] {
  const today = Math.floor(nowMs / DAY);
  const machines = DEMO_MACHINES.filter((m) => m.active);
  const operators = Object.keys(DEMO_FOBS);
  const out: SessionRecord[] = [];
  for (let day = today - days; day < today; day++) {
    const random = mulberry32(
      Number.parseInt(digest(`${seed}:${deviceId}:${tankId}:${day}`).slice(0, 8), 16),
    );
    const perDay = 2 + Math.floor(random() * 5);
    for (let i = 0; i < perDay; i++) {
      const start = day * DAY + (6 + Math.floor(random() * 12)) * HOUR + i * 17 * 60_000;
      const liters = Math.round((15 + random() * 170) * 10) / 10;
      const minutes = Math.max(1, Math.round(liters / 60));
      const operatorId = operators[Math.floor(random() * operators.length)] ?? "op-0007";
      const machine = machines[Math.floor(random() * machines.length)];
      out.push({
        // "v2": records now carry the equipment number, so they get new ids instead of
        // conflicting with demo history that an earlier version of this script stored.
        sessionId: uuidFrom(`v2:${seed}:${deviceId}:${tankId}:${day}:${i}`),
        deviceId,
        tankId,
        operatorId,
        machineId: machine?.machineId ?? "m-t12",
        equipmentNumber: machine?.equipmentNumber ?? "T-12",
        startedAtMs: start,
        endedAtMs: start + minutes * 60_000,
        liters,
        endReason: REASONS[Math.floor(random() * REASONS.length)] ?? "operator_stop",
      } as unknown as SessionRecord);
    }
  }
  return out;
}

if (import.meta.main) {
  await runCli(async () => {
    const { values } = parseArgs({
      options: {
        server: { type: "boolean", default: false },
        history: { type: "string", default: "0" },
        device: { type: "string", default: "pump-01" },
        tank: { type: "string", default: "tank-1" },
      },
    });
    const db = openDatabase(controllerDbPath());
    try {
      seedController(new ControllerStore(db), createUidHasher(requireEnv("FOB_SALT")));
      console.log(
        `controller seeded: ${DEMO_MACHINES.length} machines, ${Object.keys(DEMO_FOBS).length} operators`,
      );
    } finally {
      db.close();
    }
    if (values.server) {
      const days = Number(values.history);
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        throw new Error("--history must be a whole number of days from 0 to 365");
      }
      const connection = connect(requireEnv("DATABASE_URL"));
      try {
        const now = Date.now();
        // Print each token as soon as it is issued: it replaces the old one and is not shown again.
        console.log("demo tokens (shown once; for local development only):");
        const deviceToken = await issueDeviceToken(
          connection.db,
          { deviceId: values.device, tankId: values.tank },
          now,
        );
        console.log(`  device ${values.device}: ${deviceToken}`);
        const managerToken = await issueManagerToken(connection.db, { managerId: "mgr-demo" }, now);
        console.log(`  manager mgr-demo: ${managerToken}`);
        if (days > 0) {
          const repo = new MysqlRepository(connection.db);
          const records = historyRecords(values.device, values.tank, now, days);
          const counts = { stored: 0, duplicate: 0, conflict: 0 };
          for (let i = 0; i < records.length; i += 50) {
            for (const ack of await repo.storeBatch(records.slice(i, i + 50), now)) {
              counts[ack.status]++;
            }
          }
          console.log(
            `server history: ${counts.stored} stored, ${counts.duplicate} already present, ${counts.conflict} conflicting`,
          );
          if (counts.conflict > 0)
            throw new Error("some dummy sessions conflict with existing data");
        }
      } finally {
        await connection.close();
      }
    }
  });
}
