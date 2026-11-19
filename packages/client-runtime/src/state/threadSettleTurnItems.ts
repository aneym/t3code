import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";

// Only still-active local copies take the server's item: events applied meanwhile win,
// and inherited rows belong to another thread.
export function settleTurnItems(
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjection,
  settled: ReadonlyMap<string, OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection {
  let changed = false;
  const settle = (item: OrchestrationV2TurnItem, id: string) => {
    const server = settled.get(id);
    if (server === undefined || !isOrchestrationV2WorkActive(item.status)) return item;
    changed = true;
    return server;
  };
  const turnItems = projection.turnItems.map((item) => settle(item, item.id));
  const visibleTurnItems = projection.visibleTurnItems.map((row) => {
    if (row.sourceThreadId !== threadId) return row;
    const item = settle(row.item, row.sourceItemId);
    return item === row.item ? row : { ...row, item };
  });
  return changed ? { ...projection, turnItems, visibleTurnItems } : projection;
}
