import type { AgentPlacementHealthLine } from "@t3tools/contracts";
import { readAgentMainThreads } from "../agents/AgentHomeFiles.ts";

export const EVERY_CHILD = "*";
const MAIN_CHILDREN = "agent-main";

export interface GroupLimit {
  readonly perGroup: number | undefined;
  readonly staggerMs: number | undefined;
  readonly except: ReadonlySet<string>;
  readonly exceptParents: ReadonlySet<string>;
  readonly parents: ReadonlySet<string>;
  readonly fastMs: number | undefined;
  readonly loadLine: boolean;
}

export interface ChildOrigin {
  readonly provider?: string | null | undefined;
  readonly parent?: string | null | undefined;
  readonly requested_at?: string | null | undefined;
}

type Limits = ReadonlyMap<string, GroupLimit>;

const NONE: ReadonlySet<string> = new Set();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInt = (value: unknown, min: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : undefined;

export const childStartLimits = async (
  raw: unknown,
  mainThreads: () => Promise<ReadonlySet<string>> = readAgentMainThreads,
): Promise<Limits> => {
  const limits = new Map<string, GroupLimit>();
  if (!isRecord(raw)) return limits;
  let mains: ReadonlySet<string> | undefined;
  const readMains = async () => (mains ??= await mainThreads().catch(() => NONE));
  for (const [group, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const fastMinutes = positiveInt(entry.fastMinutes, 1);
    const limit = {
      perGroup: positiveInt(entry.perGroup, 0),
      staggerMs: positiveInt(entry.staggerMs, 0),
      except: new Set(
        Array.isArray(entry.except)
          ? entry.except.filter((name): name is string => typeof name === "string")
          : [],
      ),
      exceptParents: entry.exceptParents === MAIN_CHILDREN ? await readMains() : NONE,
      parents: group === MAIN_CHILDREN ? await readMains() : NONE,
      fastMs: fastMinutes === undefined ? undefined : fastMinutes * 60_000,
      loadLine: entry.loadLine !== false,
    };
    if (limit.perGroup !== undefined || limit.staggerMs !== undefined) limits.set(group, limit);
  }
  return limits;
};

export const limitedGroups = (
  limits: Limits,
  candidates: ReadonlyArray<string | null>,
  child: ChildOrigin,
  now: number,
) => {
  const fast = limits.get(MAIN_CHILDREN);
  const since = child.requested_at;
  const old =
    fast?.fastMs !== undefined &&
    typeof since === "string" &&
    now - Date.parse(since) > fast.fastMs;
  const from = (parents: ReadonlySet<string>) =>
    !old && child.parent != null && parents.has(child.parent);
  const groups = candidates.filter((group): group is string => {
    if (group === null || group === MAIN_CHILDREN) return false;
    const limit = limits.get(group);
    return (
      limit !== undefined &&
      (child.provider == null || !limit.except.has(child.provider)) &&
      !from(limit.exceptParents)
    );
  });
  return fast !== undefined && since !== null && from(fast.parents)
    ? [...groups, MAIN_CHILDREN]
    : groups;
};

export const allows = (
  limits: Limits,
  group: string,
  running: ReadonlyMap<string, number>,
  started: ReadonlyMap<string, number>,
  now: number,
) => {
  const limit = limits.get(group);
  return (
    limit === undefined ||
    ((limit.perGroup === undefined || (running.get(group) ?? 0) < limit.perGroup) &&
      (limit.staggerMs === undefined || now - (started.get(group) ?? 0) >= limit.staggerMs))
  );
};

export const healthLineFor = (
  limits: Limits,
  groups: ReadonlyArray<string>,
  line: AgentPlacementHealthLine,
): AgentPlacementHealthLine =>
  groups.some((group) => limits.get(group)?.loadLine === false)
    ? { ...line, maxLoadPerCore: Infinity }
    : line;
