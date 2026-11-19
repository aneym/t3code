import type { OrchestrationV2AppThreadLineage, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const MAX_SUBAGENT_HOPS = 8;

export interface LineageEntry {
  readonly id: ThreadId;
  readonly lineage: OrchestrationV2AppThreadLineage;
}

export const subagentParentOf = (lineage: OrchestrationV2AppThreadLineage): ThreadId | null =>
  lineage.relationshipToParent === "subagent" ? lineage.parentThreadId : null;

export function subagentClosure(
  hops: ReadonlyMap<ThreadId, number>,
  entries: Iterable<LineageEntry>,
): Map<ThreadId, number> {
  const parents = new Map<ThreadId, ThreadId>();
  for (const entry of entries) {
    const parent = subagentParentOf(entry.lineage);
    if (parent !== null) parents.set(entry.id, parent);
  }
  const known = new Map(hops);
  const unreachable = new Set<ThreadId>();
  for (const id of parents.keys()) {
    const path: Array<ThreadId> = [];
    let current = id;
    let base: number | undefined;
    while (path.length < MAX_SUBAGENT_HOPS) {
      base = known.get(current);
      if (base !== undefined || unreachable.has(current)) break;
      const parent = parents.get(current);
      if (parent === undefined) break;
      path.push(current);
      current = parent;
    }
    if (base === undefined) base = known.get(current);
    if (base === undefined) {
      if (!parents.has(current) || unreachable.has(current)) {
        for (const step of path) unreachable.add(step);
      }
      continue;
    }
    path.forEach((step, index) => {
      const depth = base + path.length - index;
      if (depth <= MAX_SUBAGENT_HOPS) known.set(step, depth);
    });
  }
  return known;
}

export const climbToSet = Effect.fnUntraced(function* <E>(
  threadId: ThreadId,
  hopsOf: (threadId: ThreadId) => number | undefined,
  lineageOf: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThreadLineage | null, E>,
) {
  const path: Array<ThreadId> = [];
  let current = threadId;
  while (path.length < MAX_SUBAGENT_HOPS) {
    const lineage = yield* lineageOf(current);
    const parent = lineage === null ? null : subagentParentOf(lineage);
    if (parent === null) return [];
    path.push(current);
    const base = hopsOf(parent);
    if (base !== undefined) {
      const found = path.map((step, index) => [step, base + path.length - index] as const);
      return found.every(([, depth]) => depth <= MAX_SUBAGENT_HOPS) ? found : [];
    }
    current = parent;
  }
  return [];
});
