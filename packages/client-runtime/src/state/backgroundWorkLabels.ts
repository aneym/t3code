export interface RepeatedLabelGroup<T> {
  readonly first: T;
  readonly count: number;
}

export function groupRepeatedLabels<T>(
  items: ReadonlyArray<T>,
  labelOf: (item: T) => string,
): ReadonlyArray<RepeatedLabelGroup<T>> {
  const groups = new Map<string, { first: T; count: number }>();
  for (const item of items) {
    const label = labelOf(item);
    const group = groups.get(label);
    if (group) group.count += 1;
    else groups.set(label, { first: item, count: 1 });
  }
  return Array.from(groups.values());
}

export const repeatCountSuffix = (count: number): string => (count > 1 ? ` (${count})` : "");

export const backgroundWorkLabelList = (items: ReadonlyArray<{ readonly label: string }>): string =>
  groupRepeatedLabels(items, (item) => item.label)
    .map(({ first, count }) => `${first.label}${repeatCountSuffix(count)}`)
    .join(", ");
