import { SyncRequest, type SyncResponse } from "@agriflow/core";
import Fastify, { type FastifyInstance } from "fastify";
import { hashToken, type SyncRepository } from "../db/repository.ts";

export interface AppOptions {
  readonly repository: SyncRepository;
  readonly now: () => number;
  readonly logger?: boolean;
}

/** Largest accepted request body. A full batch of 50 sessions is a few tens of kilobytes. */
const BODY_LIMIT_BYTES = 256 * 1024;

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,256})$/.exec(header ?? "");
  return match?.[1];
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { repository, now } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: BODY_LIMIT_BYTES });

  // Never leak internal error details to clients.
  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) request.log.error({ err: error }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "internal_error" : "bad_request" });
  });

  app.get("/v1/health", async () => ({ status: "ok" }));

  app.post("/v1/sync/sessions", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) return reply.code(401).send({ error: "unauthorized" });
    const device = await repository.findDeviceByTokenHash(hashToken(token));
    if (device === undefined) return reply.code(401).send({ error: "unauthorized" });

    const parsed = SyncRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { deviceId, sessions } = parsed.data;

    // A device may only submit its own sessions, for its own tank.
    if (
      deviceId !== device.deviceId ||
      sessions.some((s) => s.deviceId !== device.deviceId || s.tankId !== device.tankId)
    ) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const acks = await repository.storeBatch(sessions, now());
    const body: SyncResponse = { acks };
    return body;
  });

  return app;
}
