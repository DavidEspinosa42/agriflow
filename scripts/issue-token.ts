import { parseArgs } from "node:util";
import { connect } from "../apps/server/src/db/connection.ts";
import { issueDeviceToken, issueManagerToken } from "../apps/server/src/db/tokens.ts";
import { requireEnv, runCli } from "./lib.ts";

/**
 * Issue or rotate a token. It is printed once and only its hash is stored.
 *   pnpm issue-token device --id pump-01 --tank tank-1
 *   pnpm issue-token manager --id mgr-1
 */
await runCli(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { id: { type: "string" }, tank: { type: "string" } },
  });
  const kind = positionals[0];
  if (values.id === undefined || (kind !== "device" && kind !== "manager")) {
    throw new Error(
      "usage: issue-token device --id <id> --tank <id> | issue-token manager --id <id>",
    );
  }
  const connection = connect(requireEnv("DATABASE_URL"));
  try {
    let token: string;
    if (kind === "device") {
      if (values.tank === undefined) throw new Error("--tank is required for a device");
      token = await issueDeviceToken(
        connection.db,
        { deviceId: values.id, tankId: values.tank },
        Date.now(),
      );
    } else {
      token = await issueManagerToken(connection.db, { managerId: values.id }, Date.now());
    }
    console.log(`${kind} ${values.id} token (shown once, store it safely):`);
    console.log(token);
  } finally {
    await connection.close();
  }
});
