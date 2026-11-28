import type { AgentPlacementHealthLine } from "@t3tools/contracts";
import { readAgentMainThreads } from "../agents/AgentHomeFiles.ts";

export const EVERY_CHILD = "*";
export const LIGHT_CLASS = "light";
const LANE = "*lane";
const LANE_PREFIX = `${LANE}:`;
const MAIN_THREADS = "agent-main";

export interface GroupLimit {
  readonly perGroup: number | undefined;
  readonly staggerMs: number | undefined;
  readonly except: ReadonlySet<string>;
  readonly exceptParents: ReadonlySet<string>;
  readonly members: Membership | undefined;
  readonly fastMs: number | undefined;
  readonly loadLine: boolean;
}

interface Membership {
  readonly parents: ReadonlySet<string> | undefined;
  readonly class: string | undefined;
}

export interface ChildOrigin {
  readonly provider?: string | null | undefined;
  readonly parent?: string | null | undefined;
  readonly started_at?: string | null | undefined;
  readonly class?: string | null | undefined;
}

export type Limits = ReadonlyMap<string, GroupLimit>;

const NONE: ReadonlySet<string> = new Set();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPoolName = (group: string) =>
  group.startsWith(EVERY_CHILD) && group !== EVERY_CHILD && group !== LANE;

const declaresMembership = (entry: Readonly<Record<string, unknown>>) =>
  entry.parents !== undefined || entry.class !== undefined;

const isMember = (members: Membership, child: ChildOrigin) =>
  members.parents !== undefined && child.parent != null && members.parents.has(child.parent);

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
      members:
        isPoolName(group) && declaresMembership(entry)
          ? {
              parents: entry.parents === undefined ? undefined : await threadsOf(entry.parents),
              class: typeof entry.class === "string" ? entry.class : undefined,
            }
          : undefined,
      fastMs: fastMinutes === undefined ? undefined : fastMinutes * 60_000,
      loadLine: entry.loadLine !== false,
    };
    if (limit.perGroup !== undefined || limit.staggerMs !== undefined) limits.set(group, limit);
  }
  return limits;
};

const classPoolOf = (limits: Limits, cls: string | null | undefined) => {
  if (cls == null) return undefined;
  for (const [group, limit] of limits) if (limit.members?.class === cls) return group;
  return undefined;
};

const inClassPool = (limits: Limits, child: ChildOrigin) =>
  classPoolOf(limits, child.class) !== undefined;

const inParentsPool = (limits: Limits, parent: string) =>
  [...limits.values()].some((limit) => limit.members?.parents?.has(parent) === true);

export const marksClass = (limits: Limits, cls: string, parent: string) =>
  cls === LIGHT_CLASS || (classPoolOf(limits, cls) !== undefined && !inParentsPool(limits, parent));

const poolOf = (limits: Limits, child: ChildOrigin) => {
  if (child.started_at === null) return undefined;
  const classed = classPoolOf(limits, child.class);
  if (classed !== undefined) return classed;
  for (const [group, limit] of limits) {
    if (limit.members !== undefined && isMember(limit.members, child)) return group;
  }
  return undefined;
};

const isLaneGroup = (group: string) => group.startsWith(LANE_PREFIX);

export const limitOf = (limits: Limits, group: string) =>
  limits.get(isLaneGroup(group) ? LANE : group);

export const limitedGroups = (
  limits: Limits,
  home: string | null,
  child: ChildOrigin,
  aged = false,
): ReadonlyArray<string> => {
  const pool = aged ? undefined : poolOf(limits, child);
  if (!aged && child.class === LIGHT_CLASS) return pool === undefined ? [] : [pool];
  const classed = !aged && inClassPool(limits, child);
  const spared = (limit: GroupLimit) =>
    (child.provider != null && limit.except.has(child.provider)) ||
    (!aged && child.parent != null && limit.exceptParents.has(child.parent));
  const groups = [home, EVERY_CHILD].filter((group): group is string => {
    const limit = group === null ? undefined : limits.get(group);
    return limit !== undefined && !(classed && group === EVERY_CHILD) && !spared(limit);
  });
  const every = limits.get(EVERY_CHILD);
  const laned =
    pool === undefined &&
    !classed &&
    limits.has(LANE) &&
    child.parent != null &&
    (every === undefined || !spared(every));
  return [
    ...groups,
    ...(pool === undefined ? [] : [pool]),
    ...(laned ? [`${LANE_PREFIX}${child.parent}`] : []),
  ];
};

export const agedSince = (limits: Limits, child: ChildOrigin, now: number) => {
  const pool = poolOf(limits, child);
  const fastMs = pool === undefined ? undefined : limits.get(pool)?.fastMs;
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
  if (limits.get(group)?.members !== undefined)
    return `All ${group.slice(EVERY_CHILD.length)} slots on ${here} are in use.`;
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
  light = false,
): AgentPlacementHealthLine =>
  light || groups.some((group) => limits.get(group)?.loadLine === false)
    ? { ...line, maxLoadPerCore: Infinity, maxCpuPressure: null }
    : line;
