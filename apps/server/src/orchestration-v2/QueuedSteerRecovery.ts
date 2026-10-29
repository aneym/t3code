import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { OrchestratorProjectionError } from "./OrchestratorErrors.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { foldedQueuedTurnItems } from "./QueuedRunBatch.ts";

type UserItem = Extract<OrchestrationV2TurnItem, { type: "user_message" }>;

export const makeQueuedSteerRecovery = Effect.gen(function* () {
  const store = yield* ProjectionStoreV2;
  return Effect.fn("Orchestrator.recoverSteeringBatch")(function* (
    command: Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
    pending: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) {
    if (!command.retrySteeringBatch) return [];
    const projection = yield* store
      .getThreadRecords(command.threadId, ["runs", "messages", "turnItems"], {
        messageRoles: ["user"],
        turnItemTypes: ["user_message"],
      })
      .pipe(Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })));
    const source = projection.messages.find((message) => message.id === command.messageId);
    if (source?.runId == null) return [];
    const members = foldedQueuedTurnItems(projection.turnItems, {
      id: source.runId,
      userMessageId: source.id,
    }).filter((item) => item.parentItemId !== null);
    const retain = projection.runs.find(
      (run) => run.id === source.runId,
    )?.retainBlockedCompletionHolds;
    if (members.length === 0 && !retain) return [];
    const firstEvent = pending.findLast(
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "user_message" &&
        event.payload.messageId === source.id,
    );
    const runEvent = pending.findLast(
      (event) => event.type === "run.updated" && event.payload.userMessageId === source.id,
    );
    const sourceItem = projection.turnItems.find(
      (item): item is UserItem => item.type === "user_message" && item.messageId === source.id,
    );
    const first =
      firstEvent?.type === "turn-item.updated" && firstEvent.payload.type === "user_message"
        ? firstEvent.payload
        : runEvent?.type === "run.updated" && sourceItem !== undefined
          ? {
              ...sourceItem,
              runId: runEvent.payload.id,
              nodeId: runEvent.payload.rootNodeId,
              providerThreadId: runEvent.payload.providerThreadId,
              providerTurnId: null,
              parentItemId: null,
              ordinal: runEvent.payload.ordinal * 100,
              inputIntent: "queued_turn" as const,
              updatedAt: runEvent.occurredAt,
            }
          : undefined;
    if (first === undefined || first.runId === source.runId) return [];
    const carried = recoveredBatchEvents(projection, first, members, firstEvent === undefined);
    const targetEvent = pending.findLast(
      (event) => event.type === "run.updated" && event.payload.id === first.runId,
    );
    const target =
      targetEvent?.type === "run.updated"
        ? targetEvent.payload
        : projection.runs.find((run) => run.id === first.runId);
    if (retain && target !== undefined)
      carried.push({
        type: "run.updated",
        threadId: command.threadId,
        runId: target.id,
        occurredAt: first.updatedAt,
        payload: { ...target, retainBlockedCompletionHolds: true },
      });
    return carried;
  });
});

function recoveredBatchEvents(
  projection: Pick<OrchestrationV2ThreadProjection, "messages">,
  first: UserItem,
  members: ReadonlyArray<UserItem>,
  includeFirst: boolean,
) {
  const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [];
  const base = {
    threadId: first.threadId,
    ...(first.runId === null ? {} : { runId: first.runId }),
    ...(first.nodeId === null ? {} : { nodeId: first.nodeId }),
    occurredAt: first.updatedAt,
  };
  if (includeFirst) events.push({ ...base, type: "turn-item.updated", payload: first });
  for (const [index, member] of members.entries()) {
    const message = projection.messages.find((row) => row.id === member.messageId);
    if (message === undefined) continue;
    events.push(
      {
        ...base,
        type: "message.updated",
        payload: {
          ...message,
          runId: first.runId,
          nodeId: first.nodeId,
          updatedAt: first.updatedAt,
        },
      },
      {
        ...base,
        type: "turn-item.updated",
        payload: {
          ...member,
          runId: first.runId,
          nodeId: first.nodeId,
          providerThreadId: first.providerThreadId,
          providerTurnId: first.providerTurnId,
          parentItemId:
            first.inputIntent === "steer" || first.inputIntent === "promoted_queued_to_steer"
              ? first.id
              : null,
          inputIntent:
            first.inputIntent === "steer" || first.inputIntent === "promoted_queued_to_steer"
              ? first.inputIntent
              : "queued_turn",
          ordinal: first.ordinal + index + 1,
          updatedAt: first.updatedAt,
        },
      },
    );
  }
  return events;
}
