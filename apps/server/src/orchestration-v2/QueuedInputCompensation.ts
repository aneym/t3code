import {
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { EffectOutboxError } from "./EffectOutboxModel.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutboxModel.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

type FailureCommand = Extract<
  OrchestrationV2ServerCommand,
  { type: "runtime-request.delivery.fail" }
>;
type InterruptCommand = Extract<OrchestrationV2ServerCommand, { type: "run.interrupt" }>;

export const makeQueuedInputRestorer = Effect.fn("Orchestrator.makeQueuedInputRestorer")(
  function* () {
    const outbox = yield* EffectOutboxV2;
    const projections = yield* ProjectionStoreV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    return Effect.fn("Orchestrator.restoreQueuedInputDelivery")(function* <E, R>(
      command: FailureCommand,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
      interrupt: (
        command: InterruptCommand,
        events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
        effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
      ) => Effect.Effect<unknown, E, R>,
    ) {
      if (command.queuedInputDeliveryEffectId === undefined) return true;
      const stored = yield* outbox.get(command.queuedInputDeliveryEffectId);
      if (
        Option.isNone(stored) ||
        stored.value.threadId !== command.threadId ||
        stored.value.request.type !== "queued-input.reconcile"
      )
        return false;
      const delivery = stored.value.request;
      const responses = yield* Effect.forEach(delivery.responseEffectIds, (id) => outbox.get(id));
      if (
        responses.every(
          (response) => Option.isSome(response) && response.value.status === "succeeded",
        )
      )
        return false;
      if (
        responses.some(
          (response) =>
            Option.isSome(response) &&
            (response.value.status === "pending" || response.value.status === "running"),
        )
      )
        return yield* new EffectOutboxError({
          operation: "get",
          cause: "Queued answer delivery is not settled.",
        });
      const projection = yield* projections.getThreadRecords(command.threadId, [
        "runs",
        "messages",
        "turnItems",
        "runtimeRequests",
      ]);
      const active = projection.runs.find((run) => run.id === delivery.targetRunId);
      if (active?.status === "running" || active?.status === "waiting") {
        yield* interrupt(
          {
            type: "run.interrupt",
            commandId: command.commandId,
            threadId: command.threadId,
            runId: active.id,
            holdQueue: false,
            reason: "Queued answer delivery failed; restoring queued messages.",
          },
          events,
          effects,
        );
      }
      const now = yield* DateTime.now;
      type Draft = OrchestrationV2DomainEvent extends infer Event
        ? Event extends OrchestrationV2DomainEvent
          ? Omit<Event, "id">
          : never
        : never;
      const emit = (event: Draft) =>
        ids.allocate
          .event(command)
          .pipe(
            Effect.flatMap((id) =>
              Ref.update(events, (existing) => [...existing, { ...event, id }]),
            ),
          );
      const base = { threadId: command.threadId, occurredAt: now };
      for (const { run, message, node, attempt } of delivery.members) {
        const current = projection.runs.find((candidate) => candidate.id === run.id);
        const moved = projection.messages.find((candidate) => candidate.id === message.id);
        if (current?.status !== "cancelled" || moved?.runId !== delivery.targetRunId) continue;
        yield* emit({ ...base, type: "run.updated", runId: run.id, payload: run });
        yield* emit({ ...base, type: "message.updated", runId: run.id, payload: message });
        if (node !== null)
          yield* emit({
            ...base,
            type: "node.updated",
            runId: run.id,
            nodeId: node.id,
            payload: node,
          });
        if (attempt !== null)
          yield* emit({ ...base, type: "run-attempt.updated", runId: run.id, payload: attempt });
        const item = projection.turnItems.find(
          (item) => item.id === TurnItemId.make(`pending-input-queue:${message.id}`),
        );
        if (item?.type === "user_message")
          yield* emit({
            ...base,
            type: "turn-item.updated",
            runId: run.id,
            payload: {
              ...item,
              runId: run.id,
              nodeId: message.nodeId,
              providerThreadId: run.providerThreadId,
              status: "cancelled",
              completedAt: now,
              updatedAt: now,
            },
          });
      }
      for (const request of projection.runtimeRequests) {
        if (!delivery.requestIds.includes(request.id)) continue;
        yield* emit({
          ...base,
          type: "runtime-request.updated",
          nodeId: request.nodeId,
          payload: { ...request, status: "cancelled", resolvedAt: now },
        });
        const item = projection.turnItems.find(
          (item) => item.type === "user_input_request" && item.requestId === request.id,
        );
        if (item !== undefined)
          yield* emit({
            ...base,
            type: "turn-item.updated",
            payload: { ...item, status: "failed", completedAt: now, updatedAt: now },
          });
      }
      return true;
    });
  },
);
