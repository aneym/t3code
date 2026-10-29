import {
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ServerSettings from "../serverSettings.ts";
import { resolveQueueSendAllTarget } from "./CommandPolicy.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutboxModel.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  type OrchestratorV2Error,
} from "./OrchestratorErrors.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import {
  batchableMessage,
  MAX_BATCH_SIZE,
  queuedRunBatchEvents,
  type QueuedRunBatchMember,
} from "./QueuedRunBatch.ts";
import { isAutomaticCompletionRun, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import { clearQueueHold, queueReleaseEvents, usageLimitHoldsQueue } from "./QueueHoldPolicy.ts";

type SendAllCommand = Extract<OrchestrationV2Command, { type: "queue.send-all" }>;
type PromoteCommand = Extract<OrchestrationV2Command, { type: "queued-message.promote-to-steer" }>;

function sendAllQueuedMembers(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<QueuedRunBatchMember> {
  const members: Array<QueuedRunBatchMember> = [];
  for (const run of queuedRunsInDeliveryOrder(projection)) {
    const message = batchableMessage(projection, clearQueueHold(run));
    if (message === undefined || message.delegatedCompletion !== undefined) continue;
    const first = members[0]?.run;
    if (
      first !== undefined &&
      (run.providerInstanceId !== first.providerInstanceId ||
        !modelSelectionsEqual(run.modelSelection, first.modelSelection) ||
        run.workspacePreparation?.type !== first.workspacePreparation?.type)
    )
      continue;
    members.push({ run, message });
    if (members.length === MAX_BATCH_SIZE) break;
  }
  return members;
}

export function isBlockedCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return (
    run.queueHeld === true &&
    run.queueHoldReason === "blocked" &&
    isAutomaticCompletionRun(projection, run)
  );
}

export function sendAllStartRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): OrchestrationV2Run | undefined {
  return (
    queuedRunsInDeliveryOrder(projection).find(
      (run) => !run.queueHeld && isAutomaticCompletionRun(projection, run),
    ) ?? sendAllQueuedMembers(projection)[0]?.run
  );
}

export const makeQueuedRunSendAll = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projectionStore = yield* ProjectionStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  return Effect.fn("Orchestrator.dispatchQueueSendAll")(function* <R>(input: {
    readonly command: SendAllCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
    readonly promote: (
      command: PromoteCommand,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) => Effect.Effect<
      | {
          readonly effectTypes: ReadonlyArray<PendingOrchestrationEffectV2["request"]["type"]>;
          readonly reason: string;
        }
      | undefined,
      OrchestratorV2Error,
      R
    >;
    readonly emit: <Event extends OrchestrationV2DomainEvent>(
      event: Omit<Event, "id">,
    ) => Effect.Effect<Event, OrchestratorV2Error>;
  }) {
    const { command, events, effects } = input;
    const projection = yield* projectionStore
      .getThreadRecords(
        command.threadId,
        [
          "runs",
          "messages",
          "turnItems",
          "providerTurns",
          "providerThreads",
          "providerSessions",
          "attempts",
          "nodes",
        ],
        { turnItemTypes: ["error"], messageRoles: ["user"] },
      )
      .pipe(Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })));
    const fail = (cause: string) =>
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    if (!(yield* settings.getSettings.pipe(Effect.orDie)).queueSendAll)
      return yield* fail("Send all queued messages is disabled in Settings.");
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null)
      return yield* fail("This thread is not active.");
    const members = sendAllQueuedMembers(projection);
    const target = resolveQueueSendAllTarget(projection);
    if (typeof target === "string") return yield* fail(target);
    const first = members[0];
    const starting = sendAllStartRun(projection);
    if (target === undefined ? starting === undefined : first === undefined)
      return yield* fail("There are no eligible queued messages to send.");
    if (
      target === undefined &&
      starting !== undefined &&
      usageLimitHoldsQueue(projection, starting.providerInstanceId)
    )
      return yield* fail("Continue the limited thread before resuming its queue.");
    const now = yield* DateTime.now;
    const released = new Set(members.map(({ run }) => run.id));
    for (const event of queueReleaseEvents(projection, now, (run) => released.has(run.id)))
      yield* input.emit<OrchestrationV2DomainEvent>(event);
    if (target === undefined || first === undefined) return;
    const cancelUnsettled = yield* input.promote(
      {
        ...command,
        type: "queued-message.promote-to-steer",
        queuedRunId: first.run.id,
        targetRunId: target.id,
      },
      events,
      effects,
    );
    const pending = yield* Ref.get(events);
    const firstItem = pending.findLast(
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "user_message" &&
        event.payload.messageId === first.message.id,
    );
    if (
      firstItem?.type !== "turn-item.updated" ||
      firstItem.payload.type !== "user_message" ||
      firstItem.payload.nodeId === null
    )
      return cancelUnsettled;
    const targetRun = pending.findLast(
      (event) => event.type === "run.updated" && event.payload.id === target.id,
    );
    const effectiveTarget = {
      ...(targetRun?.type === "run.updated" ? targetRun.payload : target),
      retainBlockedCompletionHolds: true,
    };
    yield* input.emit<OrchestrationV2DomainEvent>({
      type: "run.updated",
      threadId: command.threadId,
      runId: target.id,
      providerInstanceId: target.providerInstanceId,
      occurredAt: now,
      payload: effectiveTarget,
    });
    for (const event of queuedRunBatchEvents({
      members: members.slice(1),
      projection,
      target: effectiveTarget,
      rootNodeId: firstItem.payload.nodeId,
      firstItem: firstItem.payload,
      itemId: (messageId) => idAllocator.derive.userTurnItem({ messageId }),
      occurredAt: now,
      groupUnderFirst: true,
    }))
      yield* input.emit<OrchestrationV2DomainEvent>(event);
    return cancelUnsettled;
  });
});
