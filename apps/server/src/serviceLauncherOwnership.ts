// @effect-diagnostics nodeBuiltinImport:off -- Reservation protects the database snapshot boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { SERVER_OWNER_LOCK_FILE } from "./cloud/serviceProtocol.ts";

export async function reserveServiceOwnership(baseDir: string, instanceId: string) {
  const stateDir = NodePath.join(baseDir, "userdata");
  await NodeFSP.mkdir(stateDir, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, SERVER_OWNER_LOCK_FILE));
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (cause) {
    db.close();
    throw cause;
  }
  const grantPath = NodePath.join(baseDir, "runtime", "ownership-grant.json");
  const grant = await NodeFSP.open(grantPath, "w", 0o600).catch((cause: unknown) => {
    db.close();
    throw cause;
  });
  try {
    await grant.writeFile(JSON.stringify({ pid: process.pid, instanceId }));
    await grant.sync();
  } catch (cause) {
    db.close();
    throw cause;
  } finally {
    await grant.close();
  }
  let held = true;
  return {
    release: () => {
      if (held) {
        held = false;
        db.close();
      }
    },
    clear: () => NodeFSP.rm(grantPath, { force: true }),
  };
}
