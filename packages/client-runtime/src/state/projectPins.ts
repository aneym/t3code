import { generateSpreadPinOrderKeys, pinOrderKeyBetween } from "./threadSort.ts";

type PinnableProject = { readonly pinOrder?: string | null | undefined };
type PinnableGroup = {
  readonly projectKey: string;
  readonly memberProjects: readonly PinnableProject[];
};

export function projectGroupPinOrder(group: {
  readonly memberProjects: readonly PinnableProject[];
}): string | null {
  const keys = group.memberProjects.flatMap((project) =>
    project.pinOrder == null ? [] : [project.pinOrder],
  );
  return keys.sort()[0] ?? null;
}

export function pinnedProjectGroups<T extends PinnableGroup>(groups: readonly T[]): T[] {
  return groups
    .filter((group) => projectGroupPinOrder(group) !== null)
    .sort((left, right) => {
      const a = projectGroupPinOrder(left)!;
      const b = projectGroupPinOrder(right)!;
      return a < b ? -1 : a > b ? 1 : left.projectKey.localeCompare(right.projectKey);
    });
}

export function projectPinChanges<T extends PinnableGroup>(
  groups: readonly T[],
  projectKey: string,
): { group: T; pinOrder: string | null }[] {
  const group = groups.find((candidate) => candidate.projectKey === projectKey);
  if (!group) return [];
  const pinned = pinnedProjectGroups(groups);
  if (projectGroupPinOrder(group) !== null) return [{ group, pinOrder: null }];
  const remaining = pinned;
  const targetIndex = remaining.length;
  const before = remaining[targetIndex - 1];
  const after = remaining[targetIndex];
  const pinOrder = pinOrderKeyBetween(
    before ? projectGroupPinOrder(before) : null,
    after ? projectGroupPinOrder(after) : null,
  );
  if (pinOrder !== null) return [{ group, pinOrder }];
  remaining.splice(targetIndex, 0, group);
  const keys = generateSpreadPinOrderKeys(remaining.length);
  return remaining.map((candidate, index) => ({ group: candidate, pinOrder: keys[index]! }));
}

export function projectPinReorderChanges<T extends PinnableGroup>(
  groups: readonly T[],
  activeKey: string,
  overKey: string,
): { group: T; pinOrder: string | null }[] {
  const pinned = pinnedProjectGroups(groups);
  const from = pinned.findIndex((group) => group.projectKey === activeKey);
  const to = pinned.findIndex((group) => group.projectKey === overKey);
  if (from < 0 || to < 0 || from === to) return [];
  const remaining = pinned.filter((group) => group.projectKey !== activeKey);
  const group = pinned[from]!;
  const before = remaining[to - 1];
  const after = remaining[to];
  const pinOrder = pinOrderKeyBetween(
    before ? projectGroupPinOrder(before) : null,
    after ? projectGroupPinOrder(after) : null,
  );
  if (pinOrder !== null) return [{ group, pinOrder }];
  remaining.splice(to, 0, group);
  const keys = generateSpreadPinOrderKeys(remaining.length);
  return remaining.map((candidate, index) => ({ group: candidate, pinOrder: keys[index]! }));
}
