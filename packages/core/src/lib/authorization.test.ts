import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authorize, isAuthorizationValid } from "./authorization.ts";
import type { Credential, Machine } from "./schemas.ts";

const settings = { authorizationTtlSeconds: 60 };
const ref = "a".repeat(64) as Credential["credentialRef"];

const machineArb = fc.record({
  machineId: fc.constantFrom("m1", "m2", "m3"),
  equipmentNumber: fc.constant("T-1"),
  active: fc.boolean(),
}) as unknown as fc.Arbitrary<Machine>;

const credentialArb = fc.record({
  credentialRef: fc.constant(ref),
  operatorId: fc.constantFrom("op-1", "op-2"),
  machineAccess: fc.oneof(
    fc.constant("all" as const),
    fc.subarray(["m1", "m2", "m3"]) as unknown as fc.Arbitrary<Credential["machineAccess"]>,
  ),
  expiresAtMs: fc.option(fc.nat({ max: 2_000_000 }), { nil: null }),
  revoked: fc.boolean(),
}) as unknown as fc.Arbitrary<Credential>;

function expectedAllowed(c: Credential, m: Machine, nowMs: number): boolean {
  if (c.revoked) return false;
  if (c.expiresAtMs !== null && nowMs >= c.expiresAtMs) return false;
  if (!m.active) return false;
  return c.machineAccess === "all" || c.machineAccess.includes(m.machineId);
}

describe("authorize", () => {
  it("allows exactly when every condition holds (invariant 1)", () => {
    fc.assert(
      fc.property(credentialArb, machineArb, fc.nat({ max: 2_000_000 }), (c, m, nowMs) => {
        const d = authorize({ nowMs, credential: c, machine: m, settings });
        expect(d.allowed).toBe(expectedAllowed(c, m, nowMs));
      }),
    );
  });

  it("never outlives the credential expiry", () => {
    fc.assert(
      fc.property(credentialArb, machineArb, fc.nat({ max: 2_000_000 }), (c, m, nowMs) => {
        const d = authorize({ nowMs, credential: c, machine: m, settings });
        if (!d.allowed) return;
        expect(d.authorization.expiresAtMs).toBeLessThanOrEqual(nowMs + 60_000);
        if (c.expiresAtMs !== null) {
          expect(d.authorization.expiresAtMs).toBeLessThanOrEqual(c.expiresAtMs);
          expect(isAuthorizationValid(d.authorization, c.expiresAtMs)).toBe(false);
        }
      }),
    );
  });

  it("never allows without a credential or without an identified machine", () => {
    fc.assert(
      fc.property(credentialArb, machineArb, (c, m) => {
        expect(authorize({ nowMs: 0, credential: undefined, machine: m, settings }).allowed).toBe(
          false,
        );
        expect(authorize({ nowMs: 0, credential: c, machine: undefined, settings }).allowed).toBe(
          false,
        );
      }),
    );
  });

  it("reports a deterministic reason", () => {
    const d = authorize({ nowMs: 0, credential: undefined, machine: undefined, settings });
    expect(d).toEqual({ allowed: false, reason: "unknown_credential" });
  });

  it("grants a window of exactly the configured ttl", () => {
    const c: Credential = {
      credentialRef: ref,
      operatorId: "op-1" as Credential["operatorId"],
      machineAccess: "all",
      expiresAtMs: null,
      revoked: false,
    };
    const m: Machine = {
      machineId: "m1" as Machine["machineId"],
      equipmentNumber: "T-1",
      active: true,
    };
    const d = authorize({ nowMs: 1000, credential: c, machine: m, settings });
    if (!d.allowed) throw new Error("expected allowed");
    expect(d.authorization.expiresAtMs).toBe(61_000);
    expect(isAuthorizationValid(d.authorization, 60_999)).toBe(true);
    expect(isAuthorizationValid(d.authorization, 61_000)).toBe(false);
    expect(isAuthorizationValid(d.authorization, 999)).toBe(false);
  });
});
