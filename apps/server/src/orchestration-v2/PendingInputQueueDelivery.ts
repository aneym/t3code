import {
  CommandId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import type { PendingOrchestrationEffectV2, QueuedInputDelivery } from "./EffectOutboxModel.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import {
  batchedProviderText,
  queuedRunBatchEvents,
  queuedPlainTextPrefix,
} from "./QueuedRunBatch.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

type DeliveryProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "messages" | "runtimeRequests" | "nodes" | "turnItems" | "attempts"
>;
type RespondCommand = Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>;

function pendingInputQueueDelivery(projection: DeliveryProjection) {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
  const active = projection.runs.findLast(
    (run) => run.status === "running" || run.status === "waiting",
  );
  if (active === undefined || active.rootNodeId === null || active.providerThreadId === null)
    return;
  const pending = projection.runtimeRequests.filter(
    (request) =>
      request.status === "pending" &&
      projection.nodes.some((node) => node.id === request.nodeId && node.runId === active.id),
  );
  if (pending.some((request) => request.kind !== "user_input")) return;
  const requests = pending.filter(
    (request) => request.kind === "user_input" && request.responseCapability.type === "live",
  );
  if (requests.length === 0) return;
  const members = queuedPlainTextPrefix(projection, active);
  if (members.length === 0) return;
  const text = `No option chosen. New messages arrived while this question was open:\n\n${batchedProviderText(members.map(({ message }) => ({ ...message, text: projectComposerContextForProvider({ text: message.text, records: message.context?.records ?? [] }) })))}\n\nHandle them. Ask the question again only if you still need the answer.`;
  const responses = [];
  for (const request of requests) {
    const item = projection.turnItems.find(
      (candidate) =>
        candidate.type === "user_input_request" &&
        candidate.requestId === request.id &&
        candidate.nodeId === request.nodeId,
    );
    if (item?.type !== "user_input_request") return;
    const questionIds = item.questions.map((question) => question.id);
    responses.push({
      request,
      answers: Object.fromEntries(
        (questionIds.length > 0 ? questionIds : ["answer"]).map((id) => [id, text]),
      ),
    });
  }
  return { active, members, responses };
}

export const watchPendingInputQueueDelivery = Effect.fn(
  "Orchestrator.watchPendingInputQueueDelivery",
)(function* <E, R>(
  respond: (
    command: RespondCommand,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<void, E, R>,
) {
  const eventSink = yield* EventSinkV2;
  const projections = yield* ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const deliver = Effect.fn("Orchestrator.deliverQueuedMessagesToPendingInput")(function* (
    threadId: ThreadId,
  ) {
    if ((yield* outbox.restartPrepared) !== undefined) return;
    if (!(yield* settings.getSettings).queuedMessagesAnswerPendingInput) return;
    const pending = yield* projections.getThreadRecords(threadId, ["runtimeRequests"]);
    if (
      !pending.runtimeRequests.some(
        (request) =>
          request.kind === "user_input" &&
          request.status === "pending" &&
          request.responseCapability.type === "live",
      )
    )
      return;
    const records = yield* projections.getThreadRecords(
      threadId,
      ["runs", "messages", "nodes", "turnItems", "attempts"],
      { messageRoles: ["user"], turnItemTypes: ["user_input_request"] },
    );
    const projection = { ...records, runtimeRequests: pending.runtimeRequests };
    const plan = pendingInputQueueDelivery(projection);
    if (plan === undefined) return;
    const commandId = CommandId.make(
      `command:pending-input-queue:${plan.responses[0]!.request.id}:${plan.members[0]!.run.id}`,
    );
    const events = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
    const effects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
    for (const { request, answers } of plan.responses) {
      yield* respond(
        { type: "runtime-request.respond", commandId, threadId, requestId: request.id, answers },
        events,
        effects,
      );
    }
    yield* Ref.update(effects, (pending) =>
      pending.map((effect, index) =>
        index !== 0 || effect.request.type !== "runtime-request.respond"
          ? effect
          : {
              ...effect,
              request: {
                ...effect.request,
                queuedInputDelivery: {
                  targetRunId: plan.active.id,
                  queuedRunIds: plan.members.map(({ run }) => run.id),
                },
              },
            },
      ),
    );
    yield* eventSink.writeWithEffects({
      events: yield* Ref.get(events),
      effects: yield* Ref.get(effects),
    });
  });
  const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
  yield* Stream.merge(
    Stream.merge(
      eventSink.stream({ afterSequence, eventType: "run.created" }),
      eventSink.stream({ afterSequence, eventType: "run.updated" }),
    ).pipe(
      Stream.filter(
        (stored) =>
          (stored.event.type === "run.created" || stored.event.type === "run.updated") &&
          stored.event.payload.status === "queued",
      ),
    ),
    Stream.merge(
      eventSink
        .stream({ afterSequence, eventType: "runtime-request.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "runtime-request.updated" &&
              stored.event.payload.kind === "user_input" &&
              stored.event.payload.status === "pending",
          ),
        ),
      eventSink
        .stream({ afterSequence, eventType: "turn-item.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "turn-item.updated" &&
              stored.event.payload.type === "user_input_request" &&
              (stored.event.payload.status === "pending" ||
                stored.event.payload.status === "waiting"),
          ),
        ),
    ),
  ).pipe(
    Stream.runForEach((stored) =>
      locks
        .withLock(stored.event.threadId, outbox.withDispatch(deliver(stored.event.threadId)))
        .pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Queued messages could not answer pending input", {
              threadId: stored.event.threadId,
            }),
          ),
        ),
    ),
    Effect.forkDetach,
  );
});

export class QueuedInputDeliveryError extends Schema.TaggedError<QueuedInputDeliveryError>()(
  "QueuedInputDeliveryError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {}

export const makeQueuedInputCompletion = Effect.fn("Orchestrator.makeQueuedInputCompletion")(
  function* () {
    const projections = yield* ProjectionStoreV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    return Effect.fn("Orchestrator.completeQueuedInputDelivery")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly commandId: CommandId;
        readonly delivery: QueuedInputDelivery;
      }) {
        const { threadId, commandId } = input;
        const projection = yield* projections.getThreadRecords(threadId, [
          "runs",
          "messages",
          "nodes",
          "attempts",
        ]);
        const target = projection.runs.find((run) => run.id === input.delivery.targetRunId);
        if (target?.rootNodeId == null || target.providerThreadId === null)
          return yield* new QueuedInputDeliveryError({ threadId });
        const members = input.delivery.queuedRunIds.flatMap((id) => {
          const run = projection.runs.find((run) => run.id === id && run.status === "queued");
          const message = projection.messages.find((message) => message.id === run?.userMessageId);
          return run !== undefined && message !== undefined ? [{ run, message }] : [];
        });
        if (members.length === 0) return;
        const now = yield* DateTime.now;
        const firstItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> = {
          id: TurnItemId.make(`pending-input-queue:${members[0]!.message.id}`),
          threadId,
          runId: target.id,
          nodeId: target.rootNodeId,
          providerThreadId: target.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: (yield* projections.getNextTurnItemOrdinal(threadId)) - 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: members[0]!.message.id,
          inputIntent: "queued_turn",
          text: "",
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
        };
        const folded = yield* Effect.forEach(
          queuedRunBatchEvents({
            members,
            projection,
            target,
            rootNodeId: target.rootNodeId!,
            firstItem,
            itemId: (messageId) => TurnItemId.make(`pending-input-queue:${messageId}`),
            occurredAt: now,
          }),
          (event) =>
            ids.allocate
              .event({ threadId, commandId })
              .pipe(Effect.map((id) => ({ ...event, id }))),
        );

        yield* eventSink.writeWithEffects({ events: folded, effects: [] });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) => new QueuedInputDeliveryError({ threadId: input.threadId, cause }),
          ),
        ),
    );
  },
);
