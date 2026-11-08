import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);

export const OperatorId = id.brand<"OperatorId">();
export const MachineId = id.brand<"MachineId">();
export const DeviceId = id.brand<"DeviceId">();
export const TankId = id.brand<"TankId">();
export const SessionId = z.uuid().brand<"SessionId">();
export const CredentialRef = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "credential reference must be a SHA-256 hex digest")
  .brand<"CredentialRef">();

export const EquipmentNumber = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z0-9-]+$/);

/** Milliseconds since the Unix epoch. Time is always passed in, never read inside core. */
export const TimestampMs = z.int().nonnegative();

export type OperatorId = z.infer<typeof OperatorId>;
export type MachineId = z.infer<typeof MachineId>;
export type DeviceId = z.infer<typeof DeviceId>;
export type TankId = z.infer<typeof TankId>;
export type SessionId = z.infer<typeof SessionId>;
export type CredentialRef = z.infer<typeof CredentialRef>;
export type EquipmentNumber = z.infer<typeof EquipmentNumber>;
export type TimestampMs = z.infer<typeof TimestampMs>;

export const MachineAccess = z.union([z.literal("all"), z.array(MachineId)]);
export type MachineAccess = z.infer<typeof MachineAccess>;

export const Machine = z.strictObject({
  machineId: MachineId,
  equipmentNumber: EquipmentNumber,
  active: z.boolean(),
});
export type Machine = z.infer<typeof Machine>;

export const Credential = z.strictObject({
  credentialRef: CredentialRef,
  operatorId: OperatorId,
  machineAccess: MachineAccess,
  /** null means the credential never expires. */
  expiresAtMs: TimestampMs.nullable(),
  revoked: z.boolean(),
});
export type Credential = z.infer<typeof Credential>;
