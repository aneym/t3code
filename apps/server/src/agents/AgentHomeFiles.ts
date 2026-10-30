// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off cryptoRandomUUID:off -- Node watcher callbacks and atomic rename form the filesystem boundary.
import { AGENT_HOME_HANDLE_PATTERN, AgentHome, AgentHomeBinding } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { lanesUnder, type createLaneReader } from "./AgentLaneFiles.ts";

const agentFile = async (root: string, handle: string) => {
  if (!AGENT_HOME_HANDLE_PATTERN.test(handle)) throw new Error("Invalid agent handle");
  const home = NodePath.join(root, handle);
  const file = NodePath.join(home, "agent.json");
  if (!(await NodeFSP.lstat(home)).isDirectory() || (await NodeFSP.lstat(file)).isSymbolicLink())
    throw new Error("Agent home must be a plain directory with a plain agent.json");
  return file;
};

export const readDocumentText = async (root: string, handle: string) =>
  NodeFSP.readFile(await agentFile(root, handle), "utf8");

export const parseDocument = (text: string) => {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("agent.json must contain an object");
  return value as Record<string, unknown>;
};

const readDocument = async (root: string, handle: string) =>
  parseDocument(await readDocumentText(root, handle));
const decodeBinding = Schema.decodeSync(AgentHomeBinding);
const decodeHome = Schema.decodeSync(AgentHome);
const text = (value: unknown) => (typeof value === "string" ? value : null);
const binding = (value: unknown): AgentHomeBinding | null => {
  if (typeof value !== "object" || value === null) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.thread_id !== "string" || !data.thread_id.trim()) return null;
  return decodeBinding({
    threadId: data.thread_id,
    environmentId: text(data.environment_id),
    host: text(data.host),
    at: text(data.at),
    by: text(data.by),
  });
};
export const homeFromDocument = (
  root: string,
  handle: string,
  doc: Record<string, unknown>,
  lanes: ReadonlyArray<{ name: string; threadId: string; host: string | null }> = [],
): AgentHome =>
  decodeHome({
    handle,
    workspaceRoot: NodePath.join(root, handle),
    displayName: text(doc.display_name),
    role: text(doc.role),
    projects: Array.isArray(doc.projects)
      ? doc.projects.filter((name): name is string => typeof name === "string")
      : [],
    lanes,
    binding: binding(doc.t3),
    previous: binding(
      typeof doc.t3 === "object" && doc.t3 !== null
        ? (doc.t3 as Record<string, unknown>).previous
        : null,
    ),
  });
export const isLaneThread = async (root: string, threadId: string) => {
  const lanes = NodePath.join(root, "..", "lanes");
  const entries = await NodeFSP.readdir(lanes, { withFileTypes: true }).catch(() => []);
  const owners = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        NodeFSP.readFile(NodePath.join(lanes, entry.name, "lane.json"), "utf8")
          .then(parseDocument)
          .then(
            (lane) => {
              const t3 = lane.t3 as { thread_id?: unknown } | undefined;
              return (
                typeof lane.parent === "string" && lane.parent !== "" && t3?.thread_id === threadId
              );
            },
            () => false,
          ),
      ),
  );
  return owners.includes(true);
};
export const readHomes = async (
  root: string,
  readLanes: ReturnType<typeof createLaneReader>,
  isLocal: (host: string) => boolean,
) => {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const lanes = await readLanes();
  const homes: AgentHome[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !AGENT_HOME_HANDLE_PATTERN.test(entry.name)) continue;
    try {
      const doc = await readDocument(root, entry.name);
      homes.push(
        homeFromDocument(
          root,
          entry.name,
          doc,
          lanesUnder(lanes, text(doc.lane) ?? entry.name, isLocal),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(`Skipping invalid agent home ${entry.name}`);
    }
  }
  return { homes: homes.sort((a, b) => a.handle.localeCompare(b.handle)) };
};
export const writeBinding = async (
  root: string,
  handle: string,
  doc: Record<string, unknown>,
  next: Record<string, unknown> | null,
  readText: string,
  projects?: ReadonlyArray<string>,
) => {
  const old =
    typeof doc.t3 === "object" && doc.t3 !== null ? (doc.t3 as Record<string, unknown>) : null;
  if (old && next) {
    const { previous: _previous, reason: _reason, ...previous } = old;
    next.previous = previous;
  }
  const target = await agentFile(root, handle);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(
      temporary,
      JSON.stringify(
        { ...doc, ...(next ? { t3: next } : {}), ...(projects ? { projects } : {}) },
        null,
        2,
      ) + "\n",
      {
        mode: (await NodeFSP.stat(target)).mode,
      },
    );
    if ((await NodeFSP.readFile(target, "utf8")) !== readText)
      throw new Error("agent.json changed while binding; try again");
    await NodeFSP.rename(temporary, target);
  } finally {
    await NodeFSP.unlink(temporary).catch(() => undefined);
  }
};
export const watchHomes = (root: string, changed: () => void) => {
  const watchers = new Map<string, NodeFS.FSWatcher>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void reconcile();
      changed();
    }, 200);
  };
  const reconcile = async () => {
    const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(() => []);
    if (closed) return;
    const paths = new Set([
      root,
      ...entries
        .filter((e) => e.isDirectory() && AGENT_HOME_HANDLE_PATTERN.test(e.name))
        .map((e) => NodePath.join(root, e.name)),
    ]);
    for (const [name, watcher] of watchers)
      if (!paths.has(name)) {
        watcher.close();
        watchers.delete(name);
      }
    for (const name of paths) {
      if (watchers.has(name)) continue;
      try {
        const watcher = NodeFS.watch(name, schedule);
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(name);
        });
        watchers.set(name, watcher);
      } catch {}
    }
  };
  void reconcile();
  const interval = setInterval(() => {
    void reconcile();
    changed();
  }, 30_000);
  return () => {
    closed = true;
    clearInterval(interval);
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
  };
};
