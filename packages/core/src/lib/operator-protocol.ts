import { z } from "zod";
import type { DenyReason } from "./authorization.ts";
import { EndReasonSchema } from "./ledger.ts";

/**
 * The messages between the controller and the operator screen. They live in core so the
 * controller and the Angular kiosk validate against one definition. Nothing here carries a fob UID.
 */

const DENY_REASONS = [
  "unknown_credential",
  "credential_revoked",
  "credential_expired",
  "unknown_machine",
  "machine_inactive",
  "machine_not_permitted",
] as const satisfies readonly DenyReason[];

// Fails to compile if a reason is added to DenyReason but not to the list above.
type MissingReason = Exclude<DenyReason, (typeof DENY_REASONS)[number]>;
const _complete: [MissingReason] extends [never] ? true : never = true;
void _complete;

export const NoticeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("denied"), reason: z.enum(DENY_REASONS) }),
  z.strictObject({ kind: z.literal("lapsed") }),
  z.strictObject({ kind: z.literal("fault"), reason: z.string().max(64) }),
]);
export type Notice = z.infer<typeof NoticeSchema>;

/** What the operator screen shows. */
export const SnapshotSchema = z.strictObject({
  phase: z.enum(["idle", "awaiting_machine", "authorized", "dispensing", "finished"]),
  pumpOn: z.boolean(),
  estopEngaged: z.boolean(),
  operatorId: z.string().nullable(),
  machineId: z.string().nullable(),
  liters: z.number().nonnegative(),
  endReason: EndReasonSchema.nullable(),
  notice: NoticeSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Commands the operator screen may send. Scans come only from the reader hardware. */
export const ClientCommand = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("select_machine"), equipmentNumber: z.string().min(1).max(32) }),
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({ type: z.literal("stop") }),
  z.strictObject({ type: z.literal("dismiss") }),
]);
export type ClientCommand = z.infer<typeof ClientCommand>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("state"), snapshot: SnapshotSchema }),
  z.strictObject({ type: z.literal("error"), error: z.enum(["invalid_json", "invalid_command"]) }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
