import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultSettings, resolveSettings } from "./settings.ts";

describe("settings", () => {
  it("matches the documented defaults", () => {
    expect(defaultSettings).toMatchObject({
      authorizationTtlSeconds: 60,
      maxSessionLiters: 600,
      idleTimeoutSeconds: 120,
      checkpointIntervalSeconds: 2,
      syncRetryBaseSeconds: 5,
      syncRetryMaxSeconds: 900,
    });
  });

  it("applies overrides and rejects unknown keys", () => {
    expect(resolveSettings({ maxSessionLiters: 300 }).maxSessionLiters).toBe(300);
    expect(() => resolveSettings({ surprise: 1 })).toThrow();
  });

  it("rejects malformed non-object overrides", () => {
    for (const bad of [null, 5, true, [], "x"]) {
      expect(() => resolveSettings(bad)).toThrow();
    }
    expect(resolveSettings(undefined)).toEqual(defaultSettings);
  });

  it("rejects non-positive values", () => {
    fc.assert(
      fc.property(fc.integer({ max: 0 }), (n) => {
        expect(() => resolveSettings({ idleTimeoutSeconds: n })).toThrow();
      }),
    );
  });

  it("requires the retry ceiling to be at least the base", () => {
    expect(() => resolveSettings({ syncRetryBaseSeconds: 10, syncRetryMaxSeconds: 5 })).toThrow();
  });
});
