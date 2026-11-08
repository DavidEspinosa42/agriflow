import type { Credential, Machine, MachineId, OperatorId, TimestampMs } from "./schemas.ts";
import type { Settings } from "./settings.ts";

export type DenyReason =
  | "unknown_credential"
  | "credential_revoked"
  | "credential_expired"
  | "unknown_machine"
  | "machine_inactive"
  | "machine_not_permitted";

export interface Authorization {
  readonly operatorId: OperatorId;
  readonly machineId: MachineId;
  readonly grantedAtMs: TimestampMs;
  readonly expiresAtMs: TimestampMs;
}

export type AuthorizationDecision =
  | { readonly allowed: true; readonly authorization: Authorization }
  | { readonly allowed: false; readonly reason: DenyReason };

export interface AuthorizeInput {
  readonly nowMs: TimestampMs;
  /** The credential matching the presented fob, or undefined if the fob is unknown. */
  readonly credential: Credential | undefined;
  /** The machine matching the entered equipment number, or undefined if unknown. */
  readonly machine: Machine | undefined;
  readonly settings: Pick<Settings, "authorizationTtlSeconds">;
}

/**
 * Decide whether a fob may refuel a machine right now. Pure: time and lookups are inputs.
 * Checks run in a fixed order so the audited reason is deterministic.
 */
export function authorize(input: AuthorizeInput): AuthorizationDecision {
  const { nowMs, credential, machine, settings } = input;
  if (credential === undefined) return deny("unknown_credential");
  if (credential.revoked) return deny("credential_revoked");
  if (credential.expiresAtMs !== null && nowMs >= credential.expiresAtMs) {
    return deny("credential_expired");
  }
  if (machine === undefined) return deny("unknown_machine");
  if (!machine.active) return deny("machine_inactive");
  if (credential.machineAccess !== "all" && !credential.machineAccess.includes(machine.machineId)) {
    return deny("machine_not_permitted");
  }
  const ttlDeadlineMs = nowMs + settings.authorizationTtlSeconds * 1000;
  const expiresAtMs =
    credential.expiresAtMs === null
      ? ttlDeadlineMs
      : Math.min(ttlDeadlineMs, credential.expiresAtMs);
  return {
    allowed: true,
    authorization: {
      operatorId: credential.operatorId,
      machineId: machine.machineId,
      grantedAtMs: nowMs,
      expiresAtMs,
    },
  };
}

/** An authorization is usable from its grant time until, but excluding, its expiry. */
export function isAuthorizationValid(authorization: Authorization, nowMs: TimestampMs): boolean {
  return nowMs >= authorization.grantedAtMs && nowMs < authorization.expiresAtMs;
}

function deny(reason: DenyReason): AuthorizationDecision {
  return { allowed: false, reason };
}
