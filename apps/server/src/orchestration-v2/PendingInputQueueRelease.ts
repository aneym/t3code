import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { queuedMessageSender } from "./QueuedRunBatch.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "messages" | "nodes" | "runtimeRequests" | "turnItems"
>;

const COMMAND_PREFIX = "command:pending-input-queue-release:";

const releaseCommands = (
  projection: Projection,
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
) => {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return [];
  const active = projection.runs.findLast(
    (run) => run.status === "running" || run.status === "waiting",
  );
  if (active === undefined) return [];
  const queued = queuedRunsInDeliveryOrder(projection).filter((run) => run.queueHeld !== true);
  if (
    queued.length === 0 ||
    queued[0]?.providerInstanceId !== active.providerInstanceId ||
    !resolveProjectProviderInstanceEnabled(
      settings,
      projection.thread.projectId,
      active.providerInstanceId,
    )
  )
    return [];
  const senders = [
    ...new Set(
      queued.map((run) => {
        const message = projection.messages.find((entry) => entry.id === run.userMessageId);
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
      (entry) =>
        entry.type === "user_input_request" &&
        entry.requestId === request.id &&
        entry.nodeId === request.nodeId,
    );
    if (item?.type !== "user_input_request" || item.questions.length === 0) return [];
    return [
      {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make(`${COMMAND_PREFIX}${request.id}`),
        threadId: projection.thread.id,
        requestId: request.id,
        answers: Object.fromEntries(item.questions.map((question) => [question.id, notice])),
      },
    ];
  });
};

const isReleaseTrigger = (event: OrchestrationV2DomainEvent) =>
  ((event.type === "run.created" || event.type === "run.updated") &&
    event.payload.status === "queued") ||
  (event.type === "runtime-request.updated" &&
    event.payload.kind === "user_input" &&
    event.payload.status === "pending") ||
  (event.type === "turn-item.updated" &&
    event.payload.type === "user_input_request" &&
    (event.payload.status === "pending" || event.payload.status === "waiting"));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const serverSettings = yield* ServerSettingsService.ServerSettingsService;

    const release = Effect.fn("PendingInputQueueRelease.release")(function* (threadId: ThreadId) {
      const settings = yield* serverSettings.getSettings;
      if (!settings.queuedMessagesAnswerPendingInput) return;
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
      const commands = releaseCommands(
        { ...records, runtimeRequests: pending.runtimeRequests },
        settings,
      );
      for (const command of commands) {
        yield* engine.dispatch(command).pipe(Effect.ignore);
      }
    });

    yield* forkParked(
      engine.streamDomainEvents.pipe(
        Stream.filter(isReleaseTrigger),
        Stream.runForEach((event) =>
          release(event.threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not release pending input for queued messages", {
                threadId: event.threadId,
                cause,
              }),
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("pending input queue release stream failed", { cause }),
        ),
      ),
    );
  }),
);
