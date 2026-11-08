import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Credential, EquipmentNumber, SessionId } from "./schemas.ts";

const ref = "a".repeat(64);

describe("schemas", () => {
  it("accepts a valid credential and rejects unknown keys", () => {
    const base = {
      credentialRef: ref,
      operatorId: "op-0007",
      machineAccess: "all",
      expiresAtMs: null,
      revoked: false,
    };
    expect(Credential.parse(base).operatorId).toBe("op-0007");
    expect(() => Credential.parse({ ...base, name: "Ana" })).toThrow();
  });

  it("rejects fob UIDs that are not hashed", () => {
    expect(() =>
      Credential.parse({
        credentialRef: "04A1B2C3",
        operatorId: "op-1",
        machineAccess: [],
        expiresAtMs: 0,
        revoked: false,
      }),
    ).toThrow();
  });

  it("accepts only uuid session ids", () => {
    expect(SessionId.safeParse("not-a-uuid").success).toBe(false);
    fc.assert(fc.property(fc.uuid(), (u) => SessionId.safeParse(u).success));
  });

  it("restricts equipment numbers to short alphanumeric strings", () => {
    expect(EquipmentNumber.safeParse("T-12").success).toBe(true);
    expect(EquipmentNumber.safeParse("T 12").success).toBe(false);
    expect(EquipmentNumber.safeParse("").success).toBe(false);
  });
});
