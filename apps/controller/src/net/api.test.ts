import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimulatedHardware } from "../hardware/simulator.ts";
import { DispensingService, type Snapshot } from "../service/dispensing-service.ts";
import { ControllerRuntime } from "../service/runtime.ts";
import { openDatabase } from "../storage/database.ts";
import { ControllerStore } from "../storage/store.ts";
import { buildApi } from "./api.ts";

const FOB = "04A1B2C3";

interface Message {
  type: string;
  snapshot?: Snapshot;
  error?: string;
}

let dir: string;
let now: number;
let db: ReturnType<typeof openDatabase>;
let app: FastifyInstance;
let runtime: ControllerRuntime;
let hardware: SimulatedHardware;
let errors: unknown[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "agriflow-api-"));
  now = 1_000_000;
  errors = [];
  db = openDatabase(join(dir, "c.db"));
  const store = new ControllerStore(db);
  store.upsertMachine({ machineId: "m1", equipmentNumber: "T-12", active: true } as never);
  store.upsertCredential({
    credentialRef: "a".repeat(64),
    operatorId: "op-0007",
    machineAccess: "all",
    expiresAtMs: null,
    revoked: false,
  } as never);
  hardware = new SimulatedHardware();
  const service = new DispensingService({
    store,
    hardware,
    deviceId: "pump-01",
    tankId: "tank-1",
    now: () => now,
    hashUid: (uid) => (uid === FOB ? "a".repeat(64) : "f".repeat(64)),
  });
  runtime = new ControllerRuntime({ service, hardware, onError: (e) => errors.push(e) });
  runtime.start();
  app = await buildApi({
    runtime,
    service,
    simulator: hardware,
    allowedOrigins: ["http://127.0.0.1:3000"],
  });
  await app.ready();
});

afterEach(async () => {
  runtime.stop();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connect() {
  const messages: Message[] = [];
  const waiters: (() => void)[] = [];
  const ws = await app.injectWS(
    "/ws",
    {},
    {
      onInit: (socket) =>
        socket.on("message", (data) => {
          messages.push(JSON.parse(data.toString()));
          for (const wake of waiters.splice(0)) wake();
        }),
    },
  );
  const next = async (predicate: (m: Message) => boolean): Promise<Message> => {
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { ws, messages, next };
}

const fakeService = {
  selectMachine: () => undefined,
  start: () => undefined,
  stop: () => undefined,
  dismiss: () => undefined,
  snapshot: () => ({}),
};

describe("controller API", () => {
  it("reports health and the current state", async () => {
    expect((await app.inject("/v1/health")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/v1/state")).json()).toMatchObject({ phase: "idle", pumpOn: false });
  });

  it("pushes state over the websocket and runs an operator flow", async () => {
    const c = await connect();
    await c.next((m) => m.snapshot?.phase === "idle");

    hardware.scan(FOB);
    await c.next((m) => m.snapshot?.phase === "awaiting_machine");

    c.ws.send(JSON.stringify({ type: "select_machine", equipmentNumber: "T-12" }));
    await c.next((m) => m.snapshot?.phase === "authorized");

    c.ws.send(JSON.stringify({ type: "start" }));
    const dispensing = await c.next((m) => m.snapshot?.phase === "dispensing");
    expect(dispensing.snapshot?.pumpOn).toBe(true);

    c.ws.send(JSON.stringify({ type: "stop" }));
    const done = await c.next((m) => m.snapshot?.phase === "finished");
    expect(done.snapshot?.pumpOn).toBe(false);
    expect(JSON.stringify(c.messages)).not.toContain(FOB);
    c.ws.terminate();
  });

  it("rejects malformed commands and never accepts scans from the network", async () => {
    const c = await connect();
    await c.next((m) => m.type === "state");
    c.ws.send("not json");
    await c.next((m) => m.error === "invalid_json");
    c.ws.send(JSON.stringify({ type: "scan", uid: FOB }));
    await c.next((m) => m.error === "invalid_command");
    c.ws.send(JSON.stringify({ type: "start", extra: 1 }));
    await c.next(() => c.messages.filter((m) => m.error === "invalid_command").length === 2);
    expect((await app.inject("/v1/state")).json()).toMatchObject({ phase: "idle", pumpOn: false });
    c.ws.terminate();
  });

  it("refuses websocket connections from untrusted browser origins", async () => {
    await expect(
      app.injectWS("/ws", { headers: { origin: "https://untrusted.example" } }),
    ).rejects.toThrow();
    const ok = await app.injectWS("/ws", { headers: { origin: "http://127.0.0.1:3000" } });
    ok.terminate();
  });

  it("turns the pump off when a handler throws", () => {
    hardware.relay.enable();
    runtime.run(() => {
      throw new Error("boom");
    });
    expect(hardware.relay.isEnabled()).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("lets the simulator routes drive the reader in development", async () => {
    const res = await app.inject({ method: "POST", url: "/dev/scan", payload: { uid: FOB } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject("/v1/state")).json()).toMatchObject({ phase: "awaiting_machine" });
  });

  it("serves the kiosk build with security headers, next to the API", async () => {
    const root = join(dir, "kiosk");
    mkdirSync(root);
    writeFileSync(join(root, "index.html"), "<!doctype html><title>kiosk</title>");
    writeFileSync(join(dir, "secret.txt"), "not for the browser");
    const web = await buildApi({
      runtime,
      service: { ...fakeService },
      allowedOrigins: [],
      staticRoot: root,
    });
    await web.ready();
    const page = await web.inject("/");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<title>kiosk</title>");
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect((await web.inject("/v1/health")).json()).toEqual({ status: "ok" });
    for (const url of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"]) {
      const res = await web.inject(url);
      expect(res.body, url).not.toContain("not for the browser");
    }
    await web.close();
  });
});
