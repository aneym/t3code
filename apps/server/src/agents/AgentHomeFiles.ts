// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off cryptoRandomUUID:off -- Node watcher callbacks and atomic rename form the filesystem boundary.
import { AGENT_HOME_HANDLE_PATTERN, AgentHome, AgentHomeBinding } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

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

export const readDocument = async (root: string, handle: string) =>
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
): AgentHome =>
  decodeHome({
    handle,
    workspaceRoot: NodePath.join(root, handle),
    displayName: text(doc.display_name),
    role: text(doc.role),
    binding: binding(doc.t3),
    previous: binding(
      typeof doc.t3 === "object" && doc.t3 !== null
        ? (doc.t3 as Record<string, unknown>).previous
        : null,
    ),
  });
export const readHomes = async (root: string) => {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const homes: AgentHome[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !AGENT_HOME_HANDLE_PATTERN.test(entry.name)) continue;
    try {
      homes.push(homeFromDocument(root, entry.name, await readDocument(root, entry.name)));
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
  next: Record<string, unknown>,
  readText: string,
) => {
  const old =
    typeof doc.t3 === "object" && doc.t3 !== null ? (doc.t3 as Record<string, unknown>) : null;
  if (old) {
    const { previous: _previous, reason: _reason, ...previous } = old;
    next.previous = previous;
  }
  const target = await agentFile(root, handle);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, JSON.stringify({ ...doc, t3: next }, null, 2) + "\n", {
      mode: (await NodeFSP.stat(target)).mode,
    });
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
