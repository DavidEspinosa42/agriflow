import { z } from "zod";

/** Per-instance settings. Every default here is a starting value, not a constant. */
export const Settings = z.strictObject({
  authorizationTtlSeconds: z.int().positive().default(60),
  maxSessionLiters: z.number().positive().default(600),
  idleTimeoutSeconds: z.int().positive().default(120),
  checkpointIntervalSeconds: z.int().positive().default(2),
  syncRetryBaseSeconds: z.int().positive().default(5),
  syncRetryMaxSeconds: z.int().positive().default(900),
  litersPerPulse: z.number().positive().default(0.01),
});
export type Settings = z.infer<typeof Settings>;

export const defaultSettings: Settings = Settings.parse({});

/** Parse stored overrides on top of defaults. Throws on unknown keys or invalid values. */
export function resolveSettings(overrides: unknown = {}): Settings {
  const result = Settings.parse(overrides);
  if (result.syncRetryMaxSeconds < result.syncRetryBaseSeconds) {
    throw new RangeError("syncRetryMaxSeconds must be >= syncRetryBaseSeconds");
  }
  return result;
}
