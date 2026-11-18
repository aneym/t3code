import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting", "queued"]);

export const KEPT_TAIL_BUDGET_SHARES = [3 / 4, 3 / 8, 3 / 16] as const;

function isLocalRow(
  projection: OrchestrationV2ThreadProjection,
  row: OrchestrationV2ProjectedTurnItem,
): boolean {
  return row.visibility === "local" || row.sourceThreadId === projection.thread.id;
}

function isRetainedDependency(
  item: OrchestrationV2TurnItem,
  pendingRequestIds: ReadonlySet<string>,
): boolean {
  return (
    item.type === "run_interrupt_request" ||
    ((item.type === "user_input_request" || item.type === "approval_request") &&
      pendingRequestIds.has(String(item.requestId)))
  );
}

function encodeHistoryCursor(snapshotSequence: number, row: OrchestrationV2ProjectedTurnItem) {
  const json = JSON.stringify({
    v: 1,
    seq: snapshotSequence,
    st: String(row.sourceThreadId),
    si: String(row.sourceItemId),
    p: row.position,
  });
  const binary = String.fromCharCode(...new TextEncoder().encode(json));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function retainedMessages(
  projection: OrchestrationV2ThreadProjection,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection["messages"] {
  const messageIds = new Set<string>();
  for (const item of turnItems) {
    if ("messageId" in item) messageIds.add(String(item.messageId));
  }
  const latestRun = projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  const runIds = new Set<string>();
  for (const run of projection.runs) {
    if (run.id === latestRun?.id || ACTIVE_RUN_STATUSES.has(run.status)) {
      runIds.add(String(run.id));
      messageIds.add(String(run.userMessageId));
    }
  }
  return projection.messages.filter(
    (message) =>
      messageIds.has(String(message.id)) ||
      (message.runId !== null && runIds.has(String(message.runId))) ||
      message.delegatedCompletion !== undefined ||
      message.workflowScript === true,
  );
}

const rowCost = (
  projection: OrchestrationV2ThreadProjection,
  row: OrchestrationV2ProjectedTurnItem,
) => JSON.stringify(row).length * (isLocalRow(projection, row) ? 2 : 1);

export function keptTailSnapshot(
  snapshot: OrchestrationV2ThreadDetailSnapshot,
  rowBudget: number,
): OrchestrationV2ThreadDetailSnapshot | null {
  const { projection } = snapshot;
  const rows = projection.visibleTurnItems;
  if (rows.length === 0) return null;
  let start = rows.length - 1;
  let spent = rowCost(projection, rows[start]!);
  while (start > 0) {
    const cost = rowCost(projection, rows[start - 1]!);
    if (spent + cost > rowBudget) break;
    spent += cost;
    start -= 1;
  }
  const visibleTurnItems = rows.slice(start);
  const localIds = new Set(
    visibleTurnItems
      .filter((row) => isLocalRow(projection, row))
      .map((row) => String(row.sourceItemId)),
  );
  const pendingRequestIds = new Set(
    projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .map((request) => String(request.id)),
  );
  const turnItems = projection.turnItems.filter(
    (item) => localIds.has(String(item.id)) || isRetainedDependency(item, pendingRequestIds),
  );
  const trimmed = start > 0;
  const latestLocalTurnOrdinal = projection.turnItems.reduce<number | null>(
    (latest, item) => (latest === null || item.ordinal > latest ? item.ordinal : latest),
    null,
  );
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projection: {
      ...projection,
      messages: retainedMessages(projection, turnItems),
      turnItems,
      visibleTurnItems,
    },
    historyCursor: trimmed
      ? encodeHistoryCursor(snapshot.snapshotSequence, visibleTurnItems[0]!)
      : (snapshot.historyCursor ?? null),
    hasMoreHistory: trimmed || snapshot.hasMoreHistory === true,
    latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? latestLocalTurnOrdinal,
  };
}
