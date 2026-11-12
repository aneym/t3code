export function mergeSidebarAgentOrder(
  saved: ReadonlyArray<string>,
  shown: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const previous = [...new Set(saved)];
  const visible = [...new Set(shown)];
  const savedHandles = new Set(previous);
  const shownHandles = new Set(visible);
  const reordered = visible.filter((handle) => savedHandles.has(handle));
  let index = 0;
  return [
    ...previous.map((handle) => (shownHandles.has(handle) ? reordered[index++]! : handle)),
    ...visible.filter((handle) => !savedHandles.has(handle)),
  ];
}
