import { SyncRequest, type SyncResponse } from "@agriflow/core";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { hashToken, type SyncRepository } from "../db/repository.ts";
import type { GroupBy, ReportRepository, TransactionFilter } from "../reports/reports.ts";

export interface AppOptions {
  readonly repository: SyncRepository & ReportRepository;
  readonly now: () => number;
  /** Minutes east of UTC used to bucket days in reports. Argentina is -180. */
  readonly utcOffsetMinutes?: number;
  /** Folder with the built manager dashboard, served at "/". */
  readonly staticRoot?: string;
  readonly logger?: boolean;
}

/** Largest accepted request body. A full batch of 50 sessions is a few tens of kilobytes. */
const BODY_LIMIT_BYTES = 256 * 1024;

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,256})$/.exec(header ?? "");
  return match?.[1];
}

const Id = z.string().min(1).max(64);
const Ms = z.coerce.number().int().nonnegative();

const FilterQuery = {
  from: Ms.optional(),
  to: Ms.optional(),
  machineId: Id.optional(),
  operatorId: Id.optional(),
  deviceId: Id.optional(),
};
const TransactionsQuery = z.strictObject({
  ...FilterQuery,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const ConsumptionQuery = z.strictObject({
  ...FilterQuery,
  groupBy: z.enum(["machine", "operator", "device", "day"]).default("day"),
  utcOffsetMinutes: z.coerce.number().int().min(-840).max(840).optional(),
});

function filterOf(q: z.infer<z.ZodObject<typeof FilterQuery>>): TransactionFilter {
  return {
    fromMs: q.from,
    toMs: q.to,
    machineId: q.machineId,
    operatorId: q.operatorId,
    deviceId: q.deviceId,
  };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { repository, now } = options;
  const defaultOffset = options.utcOffsetMinutes ?? -180;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: BODY_LIMIT_BYTES });

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
  });
  if (options.staticRoot !== undefined) {
    // Registered lazily by Fastify; the dashboard is same-origin, so no CORS is needed.
    void app.register(fastifyStatic, { root: options.staticRoot });
  }

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

  // --- manager read API -------------------------------------------------------------------

  const managerOnly = async (
    request: { headers: { authorization?: string | undefined } },
    reply: { code(status: number): { send(body: unknown): unknown } },
  ): Promise<unknown> => {
    const token = bearerToken(request.headers.authorization);
    const manager =
      token === undefined ? undefined : await repository.findManagerByTokenHash(hashToken(token));
    if (manager === undefined) return reply.code(401).send({ error: "unauthorized" });
    return undefined;
  };

  app.get("/v1/transactions", { preHandler: managerOnly }, async (request, reply) => {
    const q = TransactionsQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const { items, total } = await repository.listTransactions(filterOf(q.data), {
      limit: q.data.limit,
      offset: q.data.offset,
    });
    return { items, total, limit: q.data.limit, offset: q.data.offset };
  });

  app.get("/v1/reports/consumption", { preHandler: managerOnly }, async (request, reply) => {
    const q = ConsumptionQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    const groupBy: GroupBy = q.data.groupBy;
    const rows = await repository.consumption(
      filterOf(q.data),
      groupBy,
      q.data.utcOffsetMinutes ?? defaultOffset,
    );
    return { groupBy, rows };
  });

  // Machines and operators are known to the server only through their sessions.
  for (const [path, groupBy] of [
    ["/v1/machines", "machine"],
    ["/v1/operators", "operator"],
  ] as const) {
    app.get(path, { preHandler: managerOnly }, async (request, reply) => {
      const q = z.strictObject({ from: Ms.optional(), to: Ms.optional() }).safeParse(request.query);
      if (!q.success) return reply.code(400).send({ error: "invalid_query" });
      const rows = await repository.consumption(
        { fromMs: q.data.from, toMs: q.data.to },
        groupBy,
        defaultOffset,
      );
      return { items: rows };
    });
  }

  app.get("/v1/devices", { preHandler: managerOnly }, async () => ({
    items: await repository.deviceStatus(),
  }));

  return app;
}
