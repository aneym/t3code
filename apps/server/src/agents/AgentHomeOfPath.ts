// @effect-diagnostics nodeBuiltinImport:off -- agent homes are folders on this machine.
import { AGENT_HOME_HANDLE_PATTERN } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const EXECUTOR_DIR = "executor";

const homesRoot = () =>
  process.env.T3CODE_AGENT_HOMES_DIR ?? NodePath.join(NodeOS.homedir(), ".agent-rails", "agents");

const shellsRoot = () => NodePath.join(NodePath.dirname(NodePath.resolve(homesRoot())), "shells");

const candidateRoots = () => [homesRoot(), shellsRoot()];

const resolveRoot = async (rootDir: string) =>
  NodeFSP.realpath(rootDir).catch(() => NodePath.resolve(rootDir));

export interface AgentHomeLocation {
  readonly root: string;
  readonly handle: string;
  readonly home: string;
}

interface AgentHomeDescriptor {
  readonly handle: string;
  readonly executor: boolean;
}

export const agentHomeOfPath = async (cwd: string | null): Promise<AgentHomeLocation | null> => {
  if (cwd === null) return null;
  const dir = await NodeFSP.realpath(cwd).catch(() => NodePath.resolve(cwd));
  for (const rootDir of candidateRoots()) {
    const root = await resolveRoot(rootDir);
    const relative = NodePath.relative(root, dir);
    const handle = relative.split(NodePath.sep)[0] ?? "";
    if (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative) &&
      AGENT_HOME_HANDLE_PATTERN.test(handle)
    ) {
      return { root, handle, home: NodePath.join(root, handle) };
    }
  }
  return null;
};

const agentHomeDescriptorOfPath = async (
  workspaceRoot: string,
): Promise<AgentHomeDescriptor | undefined> => {
  const location = await agentHomeOfPath(workspaceRoot);
  if (location === null) return undefined;
  const dir = await NodeFSP.realpath(workspaceRoot).catch(() => NodePath.resolve(workspaceRoot));
  if (dir === location.home) return { handle: location.handle, executor: false };
  if (dir === NodePath.join(location.home, EXECUTOR_DIR))
    return { handle: location.handle, executor: true };
  return undefined;
};

const pathSegments = (workspaceRoot: string) =>
  workspaceRoot.split(/[\\/]/).filter((part) => part.length > 0);

const parseAgentHomePathParts = (workspaceRoot: string) => {
  const segments = pathSegments(workspaceRoot);
  const last = segments.at(-1);
  const executor = last === EXECUTOR_DIR;
  const handle = executor ? segments.at(-2) : last;
  const parent = executor ? segments.at(-3) : segments.at(-2);
  if (
    handle === undefined ||
    !AGENT_HOME_HANDLE_PATTERN.test(handle) ||
    (parent !== "agents" && parent !== "shells")
  ) {
    return undefined;
  }
  return { handle, executor, shell: parent === "shells" };
};

export const AGENT_HOME_KEY_PREFIX = "agent-home:";
const AGENT_HOME_HANDLE_KEY_PREFIX = "agent-home-handle:";

export const isAgentHomeKey = (key: string) =>
  key.startsWith(AGENT_HOME_HANDLE_KEY_PREFIX) || key.startsWith(AGENT_HOME_KEY_PREFIX);

export const parseAgentHomeKey = (key: string): AgentHomeDescriptor | undefined => {
  if (key.startsWith(AGENT_HOME_HANDLE_KEY_PREFIX)) {
    const parts = key.slice(AGENT_HOME_HANDLE_KEY_PREFIX.length).split("/");
    const handle = parts[0] ?? "";
    if (!AGENT_HOME_HANDLE_PATTERN.test(handle)) return undefined;
    if (parts.length === 1) return { handle, executor: false };
    if (parts.length === 2 && parts[1] === EXECUTOR_DIR) return { handle, executor: true };
    return undefined;
  }
  if (key.startsWith(AGENT_HOME_KEY_PREFIX)) {
    const parsed = parseAgentHomePathParts(key.slice(AGENT_HOME_KEY_PREFIX.length));
    return parsed === undefined ? undefined : { handle: parsed.handle, executor: parsed.executor };
  }
  return undefined;
};

export const isAgentShellHomePath = (workspaceRoot: string) =>
  parseAgentHomePathParts(workspaceRoot)?.shell === true;

export const isAgentShellHomeRoot = async (workspaceRoot: string) => {
  const location = await agentHomeOfPath(workspaceRoot);
  if (location === null) return false;
  return location.root === (await resolveRoot(shellsRoot()));
};

export const isAgentExecutorHomeRoot = async (workspaceRoot: string) =>
  (await agentHomeDescriptorOfPath(workspaceRoot))?.executor === true;

export const agentHomeKeysOfRoot = async (
  workspaceRoot: string,
): Promise<ReadonlyArray<string>> => {
  const descriptor = await agentHomeDescriptorOfPath(workspaceRoot);
  if (descriptor === undefined) return [];
  const handleKey = `${AGENT_HOME_HANDLE_KEY_PREFIX}${descriptor.handle}${descriptor.executor ? `/${EXECUTOR_DIR}` : ""}`;
  return [handleKey, `${AGENT_HOME_KEY_PREFIX}${workspaceRoot}`];
};

export const agentHomeKeyOfRoot = async (workspaceRoot: string) =>
  (await agentHomeKeysOfRoot(workspaceRoot))[0];

export interface AgentHomeProjectCandidate {
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: unknown;
  readonly archivedAt?: string | null | undefined;
}

export const matchAgentHomeProjects = <T extends AgentHomeProjectCandidate>(
  projects: ReadonlyArray<T>,
  wanted: ReadonlyArray<string>,
): ReadonlyArray<T> => {
  const exactRoots = new Set<string>();
  const targets = new Set<string>();
  for (const key of wanted) {
    if (key.startsWith(AGENT_HOME_KEY_PREFIX)) {
      exactRoots.add(key.slice(AGENT_HOME_KEY_PREFIX.length));
    }
    const parsed = parseAgentHomeKey(key);
    if (parsed !== undefined) {
      targets.add(`${parsed.handle}\u0000${parsed.executor ? "1" : "0"}`);
    }
  }
  if (exactRoots.size === 0 && targets.size === 0) return [];
  const matches = projects.filter((project) => {
    if (project.repositoryIdentity != null) return false;
    if (exactRoots.has(project.workspaceRoot)) return true;
    const remote = parseAgentHomeKey(`${AGENT_HOME_KEY_PREFIX}${project.workspaceRoot}`);
    return (
      remote !== undefined && targets.has(`${remote.handle}\u0000${remote.executor ? "1" : "0"}`)
    );
  });
  if (matches.length <= 1) return matches;
  const active = matches.filter((project) => project.archivedAt == null);
  let pool = active.length > 0 ? active : matches;
  if (pool.length > 1) {
    const shells = pool.filter((project) => isAgentShellHomePath(project.workspaceRoot));
    if (shells.length === 1) pool = shells;
  }
  if (pool.length > 1 && exactRoots.size > 0) {
    const exact = pool.filter((project) => exactRoots.has(project.workspaceRoot));
    if (exact.length === 1) pool = exact;
  }
  return pool;
};
