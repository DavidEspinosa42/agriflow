import { parseArgs } from "node:util";
import type { Credential } from "@agriflow/core";
import { createUidHasher } from "../apps/controller/src/service/credentials.ts";
import { openDatabase } from "../apps/controller/src/storage/database.ts";
import { ControllerStore } from "../apps/controller/src/storage/store.ts";
import { controllerDbPath, readHiddenLine, requireEnv, runCli } from "./lib.ts";

const DAY_MS = 86_400_000;

export interface EnrollInput {
  readonly uid: string;
  readonly operatorId: string;
  /** "all" or the machine ids the fob may use. */
  readonly machines: "all" | readonly string[];
  readonly expiresInDays?: number | undefined;
  /** Allow a fob that already belongs to another operator to be reassigned. */
  readonly reassign?: boolean | undefined;
  readonly revoke?: boolean | undefined;
}

/**
 * Create, update or revoke the credential for a fob. Only the salted hash of the UID is stored.
 * Returns the stored credential; callers must not print the UID.
 */
export function enrollFob(
  store: ControllerStore,
  hashUid: (uid: string) => string,
  input: EnrollInput,
  nowMs: number,
): Credential {
  if (input.uid.trim() === "") throw new Error("no fob UID was read");
  const credentialRef = hashUid(input.uid);
  const existing = store.findCredential(credentialRef);
  if (existing !== undefined && existing.operatorId !== input.operatorId && !input.reassign) {
    throw new Error(
      `this fob already belongs to ${existing.operatorId}; use --reassign to move it`,
    );
  }
  if (input.revoke && existing === undefined) throw new Error("this fob is not enrolled");
  const credential = {
    credentialRef,
    operatorId: input.operatorId,
    machineAccess: input.machines === "all" ? "all" : [...input.machines],
    expiresAtMs:
      input.expiresInDays === undefined ? null : nowMs + Math.round(input.expiresInDays * DAY_MS),
    revoked: input.revoke === true,
  } as Credential;
  store.upsertCredential(credential);
  return credential;
}

if (import.meta.main) {
  await runCli(async () => {
    const { values } = parseArgs({
      options: {
        operator: { type: "string" },
        machines: { type: "string", default: "all" },
        "expires-in-days": { type: "string" },
        reassign: { type: "boolean", default: false },
        revoke: { type: "boolean", default: false },
      },
    });
    if (values.operator === undefined) {
      throw new Error(
        "usage: pnpm enroll-fob --operator <id> [--machines all|id1,id2] [--expires-in-days N] [--revoke]",
      );
    }
    const days = values["expires-in-days"];
    // The UID is read without echo, so it is not left in scrollback or shell history.
    const uid = await readHiddenLine(process.stdin, (text) => process.stderr.write(text));
    const db = openDatabase(controllerDbPath());
    try {
      const credential = enrollFob(
        new ControllerStore(db),
        createUidHasher(requireEnv("FOB_SALT")),
        {
          uid,
          operatorId: values.operator,
          machines: values.machines === "all" ? "all" : (values.machines ?? "all").split(","),
          expiresInDays: days === undefined ? undefined : Number(days),
          reassign: values.reassign,
          revoke: values.revoke,
        },
        Date.now(),
      );
      const verb = credential.revoked ? "Revoked" : "Enrolled";
      console.log(
        `${verb} fob ${credential.credentialRef.slice(0, 8)}... for ${credential.operatorId}`,
      );
    } finally {
      db.close();
    }
  });
}
