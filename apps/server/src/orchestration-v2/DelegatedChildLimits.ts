import type { AgentPlacementHealthLine } from "@t3tools/contracts";
import { readAgentMainThreads } from "../agents/AgentHomeFiles.ts";

export const EVERY_CHILD = "*";
export const FAST_POOL = "*fast";
const LANE = "*lane";
const LANE_PREFIX = `${LANE}:`;
const MAIN_THREADS = "agent-main";

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
  readonly started_at?: string | null | undefined;
}

export type Limits = ReadonlyMap<string, GroupLimit>;

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
  const threadsOf = async (spec: unknown) =>
    spec === MAIN_THREADS ? (mains ??= await mainThreads().catch(() => NONE)) : NONE;
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
      exceptParents: await threadsOf(entry.exceptParents),
      parents: group === FAST_POOL ? await threadsOf(entry.parents) : NONE,
      fastMs: fastMinutes === undefined ? undefined : fastMinutes * 60_000,
      loadLine: entry.loadLine !== false,
    };
    if (limit.perGroup !== undefined || limit.staggerMs !== undefined) limits.set(group, limit);
  }
  return limits;
};

const isFastMember = (pool: GroupLimit, child: ChildOrigin) =>
  child.parent != null && pool.parents.has(child.parent);

export const isLaneGroup = (group: string) => group.startsWith(LANE_PREFIX);

export const limitOf = (limits: Limits, group: string) =>
  limits.get(isLaneGroup(group) ? LANE : group);

export const limitedGroups = (
  limits: Limits,
  home: string | null,
  child: ChildOrigin,
  aged = false,
): ReadonlyArray<string> => {
  const pool = limits.get(FAST_POOL);
  const pooled =
    !aged && pool !== undefined && child.started_at !== null && isFastMember(pool, child);
  const spared = (limit: GroupLimit) =>
    (child.provider != null && limit.except.has(child.provider)) ||
    (!aged && child.parent != null && limit.exceptParents.has(child.parent));
  const groups = [home, EVERY_CHILD].filter((group): group is string => {
    const limit = group === null ? undefined : limits.get(group);
    return limit !== undefined && !spared(limit);
  });
  const every = limits.get(EVERY_CHILD);
  const laned =
    !pooled && limits.has(LANE) && child.parent != null && (every === undefined || !spared(every));
  return [
    ...groups,
    ...(pooled ? [FAST_POOL] : []),
    ...(laned ? [`${LANE_PREFIX}${child.parent}`] : []),
  ];
};

export const agedSince = (limits: Limits, child: ChildOrigin, now: number) => {
  const fastMs = limits.get(FAST_POOL)?.fastMs;
  if (fastMs === undefined || typeof child.started_at !== "string") return undefined;
  const since = Date.parse(child.started_at);
  return now - since > fastMs ? since : undefined;
};

export const allows = (
  limits: Limits,
  group: string,
  running: ReadonlyMap<string, number>,
  started: ReadonlyMap<string, number>,
  now: number,
) => {
  const limit = limitOf(limits, group);
  return (
    limit === undefined ||
    ((limit.perGroup === undefined || (running.get(group) ?? 0) < limit.perGroup) &&
      (limit.staggerMs === undefined || now - (started.get(group) ?? 0) >= limit.staggerMs))
  );
};

export const groupFullText = (limits: Limits, group: string, here: string) => {
  if (group === FAST_POOL) return `All fast slots on ${here} are in use.`;
  if (!isLaneGroup(group)) return `All slots for ${group} on ${here} are in use.`;
  const slots = limits.get(LANE)?.perGroup ?? 0;
  return slots === 1
    ? `This lane's 1 slot on ${here} is in use.`
    : `All ${slots} of this lane's slots on ${here} are in use.`;
};

export const healthLineFor = (
  limits: Limits,
  groups: ReadonlyArray<string>,
  line: AgentPlacementHealthLine,
): AgentPlacementHealthLine =>
  groups.some((group) => limits.get(group)?.loadLine === false)
    ? { ...line, maxLoadPerCore: Infinity, maxCpuPressure: null }
    : line;
