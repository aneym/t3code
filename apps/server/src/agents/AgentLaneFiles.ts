// @effect-diagnostics nodeBuiltinImport:off -- lane records are plain files beside the agent homes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface LaneThread {
  readonly name: string;
  readonly threadId: string;
  readonly host: string | null;
}

interface LaneRecord {
  readonly name: string;
  readonly parent: string | null;
  readonly thread: LaneThread | null;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const parseLane = (name: string, raw: string): LaneRecord | null => {
  const doc: unknown = JSON.parse(raw);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const data = doc as Record<string, unknown>;
  const open = data.closed_at == null && data.retired_at == null;
  const t3 =
    typeof data.t3 === "object" && data.t3 !== null ? (data.t3 as Record<string, unknown>) : {};
  const threadId = open ? text(t3.thread_id) : null;
  return {
    name,
    parent: text(data.parent) ?? text(data.report_to),
    thread: threadId === null ? null : { name, threadId, host: text(t3.host) },
  };
};

export const createLaneReader = (lanesDir: string) => {
  const cache = new Map<string, { readonly mtimeMs: number; readonly record: LaneRecord | null }>();
  return async (): Promise<ReadonlyArray<LaneRecord>> => {
    const entries = await NodeFSP.readdir(lanesDir, { withFileTypes: true }).catch(() => []);
    const names = new Set(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    );
    for (const name of cache.keys()) if (!names.has(name)) cache.delete(name);
    const records = await Promise.all(
      [...names].map(async (name) => {
        const file = NodePath.join(lanesDir, name, "lane.json");
        const stat = await NodeFSP.stat(file).catch(() => null);
        if (stat === null || !stat.isFile()) {
          cache.delete(name);
          return null;
        }
        const cached = cache.get(name);
        if (cached?.mtimeMs === stat.mtimeMs) return cached.record;
        const record = await NodeFSP.readFile(file, "utf8")
          .then((raw) => ({ ok: true as const, value: parseLane(name, raw) }))
          .catch(() => ({ ok: false as const, value: null }));
        if (record.ok) cache.set(name, { mtimeMs: stat.mtimeMs, record: record.value });
        else cache.delete(name);
        return record.value;
      }),
    );
    return records.filter((record): record is LaneRecord => record !== null);
  };
};

export const lanesUnder = (
  records: ReadonlyArray<LaneRecord>,
  owner: string,
): ReadonlyArray<LaneThread> => {
  const children = new Map<string, LaneRecord[]>();
  for (const record of records) {
    if (record.parent === null) continue;
    children.set(record.parent, [...(children.get(record.parent) ?? []), record]);
  }
  const seen = new Set([owner]);
  const queue = [owner];
  const threads: LaneThread[] = [];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.name)) continue;
      seen.add(child.name);
      queue.push(child.name);
      if (child.thread) threads.push(child.thread);
    }
  }
  return threads.toSorted((a, b) => a.name.localeCompare(b.name));
};
