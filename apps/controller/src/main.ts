import { z } from "zod";
import { createHardware, gpioConfigFromEnv, parseDriver } from "./hardware/factory.ts";
import { SimulatedHardware } from "./hardware/simulator.ts";
import { buildApi } from "./net/api.ts";
import { SyncWorker } from "./net/sync-worker.ts";
import { createUidHasher } from "./service/credentials.ts";
import { DispensingService } from "./service/dispensing-service.ts";
import { ControllerRuntime } from "./service/runtime.ts";
import { openDatabase } from "./storage/database.ts";
import { ControllerStore } from "./storage/store.ts";

/** An unset variable may arrive as an empty string from a copied .env file. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
/** The example value must never be used as a real secret. */
const secret = (min: number) =>
  z
    .string()
    .min(min)
    .refine((v) => !v.startsWith("change-me"), "set a real value, not the example");

const Env = z.object({
  CONTROLLER_HOST: z.string().default("127.0.0.1"),
  CONTROLLER_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  CONTROLLER_DB_PATH: z.string().default("./data/controller.db"),
  CONTROLLER_DEVICE_ID: z.string().min(1),
  CONTROLLER_TANK_ID: z.string().min(1).default("tank-1"),
  FOB_SALT: secret(16),
  /** Extra browser origins allowed to open the operator WebSocket, for example the dev server. */
  ALLOWED_ORIGINS: z.string().default(""),
  SYNC_SERVER_URL: optional(z.url()),
  CONTROLLER_DEVICE_TOKEN: optional(secret(16)),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(10),
});

/** Log only the message: stacks and causes can carry paths, UIDs or tokens. */
const logError = (error: unknown) =>
  console.error(`controller error: ${error instanceof Error ? error.message : String(error)}`);

/**
 * A hardware monitor that dies (button, E-stop, relay, meter, reader) can no longer be trusted:
 * switch the pump off and fault the session. Set once the runtime exists.
 */
let onHardwareFault: () => void = () => undefined;
const hardwareError = (error: unknown) => {
  logError(error);
  onHardwareFault();
};

const env = Env.parse(process.env);
const driver = parseDriver(process.env["HARDWARE_DRIVER"]);

const db = openDatabase(env.CONTROLLER_DB_PATH);
const store = new ControllerStore(db);
const hardware = createHardware(driver, {
  onError: hardwareError,
  ...(driver === "gpio" ? { gpio: gpioConfigFromEnv(process.env) } : {}),
});

const service = new DispensingService({
  store,
  hardware,
  deviceId: env.CONTROLLER_DEVICE_ID,
  tankId: env.CONTROLLER_TANK_ID,
  now: () => Date.now(),
  hashUid: createUidHasher(env.FOB_SALT),
});
const runtime = new ControllerRuntime({ service, hardware, onError: logError });
onHardwareFault = () => runtime.run(() => service.failSafe());

let app: Awaited<ReturnType<typeof buildApi>> | undefined;
let syncTimer: ReturnType<typeof setInterval> | undefined;
let simTimer: ReturnType<typeof setInterval> | undefined;

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (syncTimer !== undefined) clearInterval(syncTimer);
  if (simTimer !== undefined) clearInterval(simTimer);
  // Stopping also records the final liters of a running session. If that write fails, keep the
  // database open and retry before giving up; the last checkpoint is the only fallback.
  for (let attempt = 1; ; attempt++) {
    try {
      runtime.stop();
      break;
    } catch (error) {
      logError(error);
      if (attempt >= 5) {
        process.exitCode = 1;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await app?.close();
  hardware.close();
  db.close();
  // Everything is saved and closed. Exit explicitly: on Linux a blocked read on the idle evdev
  // device cannot be interrupted and would otherwise keep the process alive until the next scan.
  process.exit();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  // Do not accept input until every hardware input has a verified state.
  await hardware.ready?.();
  runtime.start();

  // The simulator has no clock of its own: let simulated fuel flow in real time.
  if (hardware instanceof SimulatedHardware) {
    let last = Date.now();
    simTimer = setInterval(() => {
      const now = Date.now();
      hardware.advance(now - last);
      last = now;
    }, 100);
    simTimer.unref();
  }

  const origins = [
    `http://127.0.0.1:${env.CONTROLLER_PORT}`,
    `http://localhost:${env.CONTROLLER_PORT}`,
    ...env.ALLOWED_ORIGINS.split(",").filter((o) => o !== ""),
  ];
  const server = await buildApi({
    runtime,
    service,
    allowedOrigins: origins,
    logger: true,
    ...(hardware instanceof SimulatedHardware ? { simulator: hardware } : {}),
  });
  app = server;

  if (env.SYNC_SERVER_URL !== undefined && env.CONTROLLER_DEVICE_TOKEN !== undefined) {
    const worker = new SyncWorker({
      store,
      deviceId: env.CONTROLLER_DEVICE_ID,
      serverUrl: env.SYNC_SERVER_URL,
      token: env.CONTROLLER_DEVICE_TOKEN,
      now: () => Date.now(),
    });
    const sync = () =>
      worker
        .runOnce()
        .then((outcome) => {
          if (outcome.kind !== "idle") server.log.info({ sync: outcome }, "sync attempt");
        })
        .catch(logError);
    syncTimer = setInterval(sync, env.SYNC_INTERVAL_SECONDS * 1000);
    void sync();
  } else {
    server.log.warn(
      "SYNC_SERVER_URL or CONTROLLER_DEVICE_TOKEN is not set; sessions stay on this device",
    );
  }

  await server.listen({ host: env.CONTROLLER_HOST, port: env.CONTROLLER_PORT });
} catch (error) {
  // A failed start (for example a busy port) must not leave GPIO processes holding the lines.
  logError(error);
  process.exitCode = 1;
  await shutdown();
}
