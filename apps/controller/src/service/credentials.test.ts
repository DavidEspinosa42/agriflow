import { CredentialRef } from "@agriflow/core";
import { describe, expect, it } from "vitest";
import { createUidHasher } from "./credentials.ts";

describe("createUidHasher", () => {
  const salt = "farm-salt-0123456789";

  it("produces a valid credential reference that does not contain the UID", () => {
    const ref = createUidHasher(salt)("04A1B2C3");
    expect(CredentialRef.safeParse(ref).success).toBe(true);
    expect(ref).not.toContain("04A1B2C3");
  });

  it("is stable, case and whitespace insensitive, and salt dependent", () => {
    const hash = createUidHasher(salt);
    expect(hash(" 04a1b2c3\n")).toBe(hash("04A1B2C3"));
    expect(createUidHasher("another-salt-0123456")("04A1B2C3")).not.toBe(hash("04A1B2C3"));
    expect(hash("04A1B2C4")).not.toBe(hash("04A1B2C3"));
  });

  it("rejects a short salt", () => {
    expect(() => createUidHasher("short")).toThrow(RangeError);
  });
});
