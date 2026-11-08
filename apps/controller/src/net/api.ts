import { ClientCommand } from "@agriflow/core";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { SimulatedHardware } from "../hardware/simulator.ts";
import type { ControllerRuntime } from "../service/runtime.ts";

export interface ApiOptions {
  readonly runtime: ControllerRuntime;
  /** The service the runtime drives; commands go through it. */
  readonly service: {
    selectMachine(equipmentNumber: string): unknown;
    start(): void;
    stop(): void;
    dismiss(): void;
    snapshot(): unknown;
  };
  /** When set, development routes that drive the simulated hardware are exposed. */
  readonly simulator?: SimulatedHardware;
  /**
   * Browser origins allowed to open the WebSocket, for example http://127.0.0.1:3000. Browsers do
   * not apply the same-origin policy to WebSockets, so this prevents other web pages from driving
   * the controller. Connections without an Origin header (not from a browser) are allowed.
   */
  readonly allowedOrigins: readonly string[];
  /** Folder with the built kiosk app to serve at "/". Omitted in tests and API-only runs. */
  readonly staticRoot?: string;
  readonly logger?: boolean;
}

/**
 * Local API for the operator screen. It is meant to listen on the loopback interface only;
 * it has no authentication because the kiosk is the only client. Scan input is never accepted
 * over the network except through the simulator routes, which exist only in development.
 */
export async function buildApi(options: ApiOptions): Promise<FastifyInstance> {
  const { runtime, service, simulator } = options;
  const app = Fastify({ logger: options.logger ?? false });
  const allowed = new Set(options.allowedOrigins);
  // The kiosk loads nothing from elsewhere and talks only to this controller.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
    );
  });
  await app.register(websocket, { options: { maxPayload: 1024 } });
  if (options.staticRoot !== undefined) {
    await app.register(fastifyStatic, { root: options.staticRoot });
  }

  app.get("/v1/health", async () => ({ status: "ok" }));
  app.get("/v1/state", async () => service.snapshot());

  const checkOrigin = async (
    request: { headers: { origin?: string | undefined } },
    reply: { code(status: number): { send(): unknown } },
  ): Promise<unknown> => {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== "" && !allowed.has(origin)) {
      return reply.code(403).send();
    }
    return undefined;
  };

  app.get("/ws", { websocket: true, preValidation: checkOrigin }, (socket) => {
    const off = runtime.subscribe((snapshot) => {
      if (socket.readyState === socket.OPEN)
        socket.send(JSON.stringify({ type: "state", snapshot }));
    });
    socket.on("close", off);
    socket.on("message", (raw: Buffer) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "invalid_json" }));
        return;
      }
      const parsed = ClientCommand.safeParse(json);
      if (!parsed.success) {
        socket.send(JSON.stringify({ type: "error", error: "invalid_command" }));
        return;
      }
      const command = parsed.data;
      runtime.run(() => {
        switch (command.type) {
          case "select_machine":
            service.selectMachine(command.equipmentNumber);
            break;
          case "start":
            service.start();
            break;
          case "stop":
            service.stop();
            break;
          case "dismiss":
            service.dismiss();
            break;
        }
      });
    });
  });

  if (simulator !== undefined) {
    const Scan = z.strictObject({ uid: z.string().min(1).max(64) });
    app.post("/dev/scan", async (request) => {
      simulator.scan(Scan.parse(request.body).uid);
      return { ok: true };
    });
    app.post("/dev/estop", async (request) => {
      const { engaged } = z.strictObject({ engaged: z.boolean() }).parse(request.body);
      if (engaged) simulator.engageEstop();
      else simulator.releaseEstop();
      return { ok: true };
    });
  }

  return app;
}
