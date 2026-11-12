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
  const temporary = `${grantPath}.${process.pid}.pending`;
  const grant = await NodeFSP.open(temporary, "w", 0o600).catch((cause: unknown) => {
    db.close();
    throw cause;
  });
  let published = false;
  try {
    await grant.writeFile(JSON.stringify({ pid: process.pid, instanceId }));
    await grant.sync();
    await NodeFSP.rename(temporary, grantPath);
    published = true;
  } catch (cause) {
    db.close();
    throw cause;
  } finally {
    await grant
      .close()
      .finally(() => (published ? undefined : NodeFSP.rm(temporary, { force: true })));
  }
  let held = true;
  return {
    release: () => {
      if (held) {
        held = false;
        db.close();
      }
    },
  };
}

export const clearOwnershipGrant = (baseDir: string) =>
  NodeFSP.rm(NodePath.join(baseDir, "runtime", "ownership-grant.json"), { force: true });

export async function sweepGrantTemps(baseDir: string): Promise<void> {
  const directory = NodePath.join(baseDir, "runtime");
  const files = await NodeFSP.readdir(directory).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  });
  await Promise.all(
    files
      .filter((name) => /^ownership-grant\.json\..+\.pending$/.test(name))
      .map((name) => NodeFSP.rm(NodePath.join(directory, name), { force: true })),
  );
}
