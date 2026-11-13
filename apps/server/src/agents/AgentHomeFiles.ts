// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off cryptoRandomUUID:off -- Node watcher callbacks and atomic rename form the filesystem boundary.
import { AGENT_HOME_HANDLE_PATTERN, AgentHome, AgentHomeBinding } from "@t3tools/contracts";
import * as NodeOS from "node:os";
import type { EnvironmentId } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { agentHomeSealing } from "./AgentHomeSealing.ts";

const watched = new Map<string, { count: number; generation: number }>();
const bump = (root: string) => {
  const entry = watched.get(NodePath.resolve(root));
  if (entry) entry.generation += 1;
};
export const homesGeneration = (root: string) => watched.get(NodePath.resolve(root))?.generation;

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
const decodeMainBinding = (value: unknown): AgentHomeBinding | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent binding");
  const data = value as Record<string, unknown>;
  if (typeof data.thread_id !== "string" || !data.thread_id.trim())
    throw new Error("Agent binding requires a nonempty string thread_id");
  return decodeBinding({
    threadId: data.thread_id,
    environmentId: text(data.environment_id),
    host: text(data.host),
    at: text(data.at),
    by: text(data.by),
  });
};
const t3Field = (doc: Record<string, unknown>, key: string) =>
  typeof doc.t3 === "object" && doc.t3 !== null
    ? (doc.t3 as Record<string, unknown>)[key]
    : undefined;
const binding = (value: unknown, strict: boolean): AgentHomeBinding | null => {
  try {
    return decodeMainBinding(value);
  } catch (error) {
    if (strict) throw error;
    return null;
  }
};
export const homeFromDocument = (
  root: string,
  handle: string,
  doc: Record<string, unknown>,
  strict = false,
): AgentHome =>
  decodeHome({
    handle,
    workspaceRoot: NodePath.join(root, handle),
    displayName: text(doc.display_name),
    role: text(doc.role),
    binding: binding(doc.t3, strict),
    previous: binding(
      typeof doc.t3 === "object" && doc.t3 !== null ? t3Field(doc, "previous") : doc.t3_previous,
      false,
    ),
    office: binding(t3Field(doc, "office"), false),
    ...(agentHomeSealing(doc) === "sealed" ? { sealed: true } : {}),
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
export const readHomes = async (root: string, strict = false) => {
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
      homes.push(homeFromDocument(root, entry.name, await readDocument(root, entry.name), strict));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      console.warn(
        `Unable to read agent home ${entry.name}; ${strict ? "settlement refused" : "home skipped"}`,
      );
      if (strict) throw error;
    }
  }
  return { homes: homes.sort((a, b) => a.handle.localeCompare(b.handle)) };
};
const writeDocument = async (
  root: string,
  handle: string,
  updated: Record<string, unknown>,
  readText: string,
) => {
  const target = await agentFile(root, handle);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, JSON.stringify(updated, null, 2) + "\n", {
      mode: (await NodeFSP.stat(target)).mode,
    });
    if ((await NodeFSP.readFile(target, "utf8")) !== readText)
      throw new Error("agent.json changed while binding; try again");
    await NodeFSP.rename(temporary, target);
    bump(root);
  } finally {
    await NodeFSP.unlink(temporary).catch(() => undefined);
  }
};
const BINDING_KEYS = new Set(["thread_id", "environment_id", "host", "at", "by"]);
export const writeBinding = async (
  root: string,
  handle: string,
  doc: Record<string, unknown>,
  next: Record<string, unknown> | null,
  readText: string,
) => {
  const old =
    typeof doc.t3 === "object" && doc.t3 !== null ? (doc.t3 as Record<string, unknown>) : null;
  const { t3: _binding, ...withoutBinding } = doc;
  const { previous: _previous, reason: _reason, office, ...rest } = old ?? {};
  const previous = Object.fromEntries(
    Object.entries(rest).filter(([key]) => BINDING_KEYS.has(key)),
  );
  const kept = Object.fromEntries(Object.entries(rest).filter(([key]) => !BINDING_KEYS.has(key)));
  const prior = old ? previous : doc.t3_previous;
  if (next) {
    for (const [key, value] of Object.entries(kept)) if (!(key in next)) next[key] = value;
    next.previous = prior;
  }
  if (next && office !== undefined && binding(office, false)?.threadId !== next.thread_id)
    next.office = office;
  const updated =
    next === null ? { ...withoutBinding, t3_previous: prior } : { ...withoutBinding, t3: next };
  await writeDocument(root, handle, updated, readText);
};
export const writeOffice = async (
  root: string,
  handle: string,
  doc: Record<string, unknown>,
  office: Record<string, unknown> | null,
  readText: string,
) => {
  const { office: _office, ...t3 } = doc.t3 as Record<string, unknown>;
  await writeDocument(root, handle, { ...doc, t3: office ? { ...t3, office } : t3 }, readText);
};
export const watchHomes = (root: string, changed: () => void) => {
  const watchers = new Map<string, NodeFS.FSWatcher>();
  const key = NodePath.resolve(root);
  const entry = watched.get(key) ?? { count: 0, generation: 0 };
  entry.count += 1;
  watched.set(key, entry);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () =>
    void reconcile().then(() => {
      bump(root);
      changed();
    });
  const schedule = () => {
    bump(root);
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  };
  const subdirectories = async (dir: string, accept: (name: string) => boolean) =>
    (await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && accept(e.name))
      .map((e) => NodePath.join(dir, e.name));
  const reconcile = async () => {
    const homes = await subdirectories(root, (name) => AGENT_HOME_HANDLE_PATTERN.test(name));
    if (closed) return;
    const paths = new Set([root, ...homes]);
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
  const interval = setInterval(refresh, 30_000);
  return () => {
    closed = true;
    entry.count -= 1;
    if (entry.count === 0) watched.delete(key);
    clearInterval(interval);
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
  };
};

const mainHomes = new Map<string, { generation: number; homes: Promise<AgentHome[]> }>();
const readMainHomes = (root: string) => {
  const generation = homesGeneration(root);
  const read = () => readHomes(root, true).then((snapshot) => snapshot.homes);
  if (generation === undefined) return read();
  const key = NodePath.resolve(root);
  const cached = mainHomes.get(key);
  if (cached?.generation === generation) return cached.homes;
  const homes = read();
  mainHomes.set(key, { generation, homes });
  homes.catch(() => {
    if (mainHomes.get(key)?.homes === homes) mainHomes.delete(key);
  });
  return homes;
};
export const readAgentMainThreads = async (environmentId?: EnvironmentId) => {
  const root =
    process.env.T3CODE_AGENT_HOMES_DIR ?? NodePath.join(NodeOS.homedir(), ".agent-rails", "agents");
  const homes = await readMainHomes(root);
  return new Set(
    homes.flatMap(({ binding, office }) =>
      [binding, office ?? null].flatMap((bound) =>
        bound !== null &&
        (environmentId === undefined ||
          bound.environmentId === null ||
          bound.environmentId === environmentId)
          ? [bound.threadId]
          : [],
      ),
    ),
  );
};
