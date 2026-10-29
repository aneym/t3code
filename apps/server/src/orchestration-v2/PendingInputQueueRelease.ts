import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { queuedMessageSender } from "./QueuedRunBatch.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "messages" | "nodes" | "runtimeRequests" | "turnItems"
>;
const commandPrefix = "command:pending-input-queue-release:";

export function isQueuedInputRelease(command: OrchestrationV2ServerCommand) {
  return command.type === "runtime-request.respond" && command.commandId.startsWith(commandPrefix);
}

function pendingInputQueueRelease(projection: Projection) {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return [];
  const active = projection.runs.findLast(
    (run) => run.status === "running" || run.status === "waiting",
  );
  if (active === undefined) return [];
  const queued = queuedRunsInDeliveryOrder(projection).filter((run) => run.queueHeld !== true);
  if (queued.length === 0) return [];
  const senders = [
    ...new Set(
      queued.map((run) => {
        const message = projection.messages.find((message) => message.id === run.userMessageId);
        return message === undefined ? "an unknown sender" : queuedMessageSender(message);
      }),
    ),
  ];
  const notice = `No option chosen. ${queued.length} new message(s) are queued for you from ${senders.join(", ")}. They will be delivered as soon as this turn ends. End your turn now. If you still need this answer after reading them, ask the question again.`;
  return projection.runtimeRequests.flatMap((request) => {
    if (
      request.kind !== "user_input" ||
      request.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      !projection.nodes.some((node) => node.id === request.nodeId && node.runId === active.id)
    )
      return [];
    const item = projection.turnItems.find(
      (item) =>
        item.type === "user_input_request" &&
        item.requestId === request.id &&
        item.nodeId === request.nodeId,
    );
    if (item?.type !== "user_input_request") return [];
    const questionIds = item.questions.map((question) => question.id);
    return [
      {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make(`${commandPrefix}${request.id}`),
        threadId: projection.thread.id,
        requestId: request.id,
        answers: Object.fromEntries(
          (questionIds.length === 0 ? ["answer"] : questionIds).map((id) => [id, notice]),
        ),
      },
    ];
  });
}

export const watchPendingInputQueueRelease = Effect.fn(
  "Orchestrator.watchPendingInputQueueRelease",
)(function* <A, E, R>(dispatch: (command: OrchestrationV2ServerCommand) => Effect.Effect<A, E, R>) {
  const projections = yield* ProjectionStoreV2;
  const eventSink = yield* EventSinkV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const outbox = yield* EffectOutboxV2;
  const release = Effect.fn("Orchestrator.releasePendingInputForQueuedMessages")(function* (
    threadId: ThreadId,
  ) {
    if (
      (yield* outbox.restartPrepared) !== undefined ||
      !(yield* settings.getSettings).queuedMessagesAnswerPendingInput
    )
      return;
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
      ["runs", "messages", "nodes", "turnItems"],
      { messageRoles: ["user"], turnItemTypes: ["user_input_request"] },
    );
    for (const command of pendingInputQueueRelease({
      ...records,
      runtimeRequests: pending.runtimeRequests,
    })) {
      yield* dispatch(command).pipe(Effect.catchCause(() => Effect.void));
    }
  });
  const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
  yield* Stream.mergeAll(
    [
      eventSink.stream({ afterSequence, eventType: "run.created" }),
      eventSink.stream({ afterSequence, eventType: "run.updated" }),
      eventSink.stream({ afterSequence, eventType: "runtime-request.updated" }),
      eventSink.stream({ afterSequence, eventType: "turn-item.updated" }),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Stream.filter(
      ({ event }) =>
        ((event.type === "run.created" || event.type === "run.updated") &&
          event.payload.status === "queued") ||
        (event.type === "runtime-request.updated" &&
          event.payload.kind === "user_input" &&
          event.payload.status === "pending") ||
        (event.type === "turn-item.updated" &&
          event.payload.type === "user_input_request" &&
          (event.payload.status === "pending" || event.payload.status === "waiting")),
    ),
    Stream.runForEach((stored) =>
      release(stored.event.threadId).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Could not release pending input for queued messages", {
            threadId: stored.event.threadId,
          }),
        ),
      ),
    ),
    Effect.forkDetach,
  );
});
