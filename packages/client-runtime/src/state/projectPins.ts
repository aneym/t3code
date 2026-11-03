import { generateSpreadPinOrderKeys, pinOrderKeyBetween } from "./threadSort.ts";

type PinnableProject = {
  readonly pinOrder?: string | null | undefined;
  readonly pinnedAt?: string | null | undefined;
};
type PinnableGroup = {
  readonly projectKey: string;
  readonly memberProjects: readonly PinnableProject[];
};

function projectGroupPinOrder(group: {
  readonly memberProjects: readonly PinnableProject[];
}): string | null {
  const keys = group.memberProjects.flatMap((project) =>
    project.pinOrder == null ? [] : [project.pinOrder],
  );
  return keys.sort()[0] ?? null;
}

type OrderedProjectPin = PinnableProject & { readonly key: string };

export function comparePinnedProjects(left: OrderedProjectPin, right: OrderedProjectPin): number {
  const a = left.pinOrder ?? null;
  const b = right.pinOrder ?? null;
  if (a !== b) return a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
  const at = left.pinnedAt ?? "";
  const bt = right.pinnedAt ?? "";
  return at < bt ? -1 : at > bt ? 1 : left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function projectGroupPinnedAt(group: {
  readonly memberProjects: readonly PinnableProject[];
}): string | null {
  return (
    group.memberProjects
      .flatMap((project) => (project.pinnedAt == null ? [] : [project.pinnedAt]))
      .sort()[0] ?? null
  );
}

export function pinnedProjectGroups<T extends PinnableGroup>(groups: readonly T[]): T[] {
  return groups
    .filter((group) => projectGroupPinnedAt(group) !== null)
    .sort((left, right) =>
      comparePinnedProjects(
        {
          key: left.projectKey,
          pinOrder: projectGroupPinOrder(left),
          pinnedAt: projectGroupPinnedAt(left),
        },
        {
          key: right.projectKey,
          pinOrder: projectGroupPinOrder(right),
          pinnedAt: projectGroupPinnedAt(right),
        },
      ),
    );
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
  if (pinOrder !== null && pinned.every((candidate) => projectGroupPinOrder(candidate) !== null))
    return [{ group, pinOrder }];
  remaining.splice(to, 0, group);
  const keys = generateSpreadPinOrderKeys(remaining.length);
  return remaining.map((candidate, index) => ({ group: candidate, pinOrder: keys[index]! }));
}
