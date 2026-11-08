import { randomBytes } from "node:crypto";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { z } from "zod";
import { hashToken } from "./repository.ts";
import { devices, managers } from "./schema.ts";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** A new random token: 256 bits, URL safe. It is shown once; only its hash is stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Register a device, or rotate its token if it already exists (which also reactivates it).
 * The previous token stops working immediately.
 */
export async function issueDeviceToken(
  db: MySql2Database,
  input: { deviceId: string; tankId: string },
  nowMs: number,
): Promise<string> {
  const deviceId = Id.parse(input.deviceId);
  const tankId = Id.parse(input.tankId);
  const token = newToken();
  await db
    .insert(devices)
    .values({ deviceId, tankId, tokenHash: hashToken(token), createdAtMs: nowMs })
    .onDuplicateKeyUpdate({ set: { tankId, tokenHash: hashToken(token), revoked: false } });
  return token;
}

export async function issueManagerToken(
  db: MySql2Database,
  input: { managerId: string },
  nowMs: number,
): Promise<string> {
  const managerId = Id.parse(input.managerId);
  const token = newToken();
  await db
    .insert(managers)
    .values({ managerId, tokenHash: hashToken(token), createdAtMs: nowMs })
    .onDuplicateKeyUpdate({ set: { tokenHash: hashToken(token), revoked: false } });
  return token;
}
