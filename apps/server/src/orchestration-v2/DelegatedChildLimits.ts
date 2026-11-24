import { readAgentMainThreads } from "../agents/AgentHomeFiles.ts";

export const EVERY_CHILD = "*";

export interface GroupLimit {
  readonly perGroup: number | undefined;
  readonly staggerMs: number | undefined;
  readonly except: ReadonlySet<string>;
  readonly exceptParents: ReadonlySet<string>;
}

export interface ChildOrigin {
  readonly provider?: string | null | undefined;
  readonly parent?: string | null | undefined;
}

const NONE: ReadonlySet<string> = new Set();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInt = (value: unknown, min: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : undefined;

export const childStartLimits = async (
  raw: unknown,
  mainThreads: () => Promise<ReadonlySet<string>> = readAgentMainThreads,
): Promise<ReadonlyMap<string, GroupLimit>> => {
  const limits = new Map<string, GroupLimit>();
  if (!isRecord(raw)) return limits;
  let mains: ReadonlySet<string> | undefined;
  for (const [group, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const limit = {
      perGroup: positiveInt(entry.perGroup, 0),
      staggerMs: positiveInt(entry.staggerMs, 0),
      except: new Set(
        Array.isArray(entry.except)
          ? entry.except.filter((name): name is string => typeof name === "string")
          : [],
      ),
      exceptParents:
        entry.exceptParents === "agent-main"
          ? (mains ??= await mainThreads().catch(() => NONE))
          : NONE,
    };
    if (limit.perGroup !== undefined || limit.staggerMs !== undefined) limits.set(group, limit);
  }
  return limits;
};

export const limitedGroups = (
  limits: ReadonlyMap<string, GroupLimit>,
  candidates: ReadonlyArray<string | null>,
  child: ChildOrigin,
) =>
  candidates.filter((group): group is string => {
    if (group === null) return false;
    const limit = limits.get(group);
    return (
      limit !== undefined &&
      (child.provider == null || !limit.except.has(child.provider)) &&
      (child.parent == null || !limit.exceptParents.has(child.parent))
    );
  });
