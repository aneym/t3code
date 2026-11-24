import {
  agedSince,
  type ChildOrigin,
  EVERY_CHILD,
  limitedGroups,
  limitOf,
  type Limits,
} from "./DelegatedChildLimits.ts";

export interface PlacedChild extends ChildOrigin {
  readonly id: string;
  readonly home: string | null;
}

const add = (counts: Map<string, number>, groups: ReadonlyArray<string>) => {
  for (const group of groups) counts.set(group, (counts.get(group) ?? 0) + 1);
};

export const tallyChildren = (
  limits: Limits,
  live: ReadonlyArray<PlacedChild>,
  held: ReadonlyArray<PlacedChild>,
  now: number,
) => {
  const running = new Map<string, number>();
  const aged: Array<{
    readonly since: number;
    readonly stay: ReadonlyArray<string>;
    readonly move: ReadonlyArray<string>;
  }> = [];
  for (const child of live) {
    const stay = limitedGroups(limits, child.home, child);
    const since = agedSince(limits, child, now);
    if (since === undefined) add(running, stay);
    else aged.push({ since, stay, move: limitedGroups(limits, child.home, child, true) });
  }
  const cap = limits.get(EVERY_CHILD)?.perGroup;
  for (const { stay, move } of [...aged].sort((a, b) => a.since - b.since)) {
    const needsSlot = move.includes(EVERY_CHILD) && !stay.includes(EVERY_CHILD);
    const free = cap === undefined || (running.get(EVERY_CHILD) ?? 0) < cap;
    add(running, !needsSlot || free ? move : stay);
  }
  const queued = new Map<string, number>();
  const groups = new Map<string, ReadonlyArray<string>>();
  const waits = new Map<string, ReadonlyArray<string>>();
  for (const child of held) {
    const childGroups = limitedGroups(limits, child.home, child);
    const full = childGroups.filter(
      (group) => (running.get(group) ?? 0) >= (limitOf(limits, group)?.perGroup ?? Infinity),
    );
    const waiting = full.length > 0 ? full : childGroups;
    groups.set(child.id, childGroups);
    waits.set(child.id, waiting);
    add(queued, waiting);
  }
  return { running, queued, groups, waits };
};
