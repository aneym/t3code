// @effect-diagnostics nodeBuiltinImport:off -- agent homes are folders on this machine.
import { AGENT_HOME_HANDLE_PATTERN } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const homesRoot = () =>
  process.env.T3CODE_AGENT_HOMES_DIR ?? NodePath.join(NodeOS.homedir(), ".agent-rails", "agents");

export interface AgentHomeLocation {
  readonly root: string;
  readonly handle: string;
  readonly home: string;
}

export const agentHomeOfPath = async (cwd: string | null): Promise<AgentHomeLocation | null> => {
  if (cwd === null) return null;
  const root = await NodeFSP.realpath(homesRoot()).catch(() => null);
  if (root === null) return null;
  const dir = await NodeFSP.realpath(cwd).catch(() => NodePath.resolve(cwd));
  const relative = NodePath.relative(root, dir);
  const handle = relative.split(NodePath.sep)[0] ?? "";
  if (relative === "" || NodePath.isAbsolute(relative) || !AGENT_HOME_HANDLE_PATTERN.test(handle))
    return null;
  return { root, handle, home: NodePath.join(root, handle) };
};
