import { createHmac } from "node:crypto";

/**
 * Builds the function that maps a raw fob UID to the stored credential reference:
 * HMAC-SHA256 keyed with the per-farm salt, hex encoded. The UID itself is never stored or logged.
 */
export function createUidHasher(salt: string): (uid: string) => string {
  if (salt.length < 16) throw new RangeError("the fob salt must be at least 16 characters");
  return (uid) => createHmac("sha256", salt).update(uid.trim().toUpperCase()).digest("hex");
}
