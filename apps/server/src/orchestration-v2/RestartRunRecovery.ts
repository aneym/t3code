import type {
  EventId,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  ServerRestartHandoff,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as DateTime from "effect/DateTime";

function cancelledRestartRun(
  run: OrchestrationV2Run,
  now: DateTime.Utc,
  handoff?: ServerRestartHandoff,
  declined = false,
) {
  return {
    ...run,
    ...(declined ? { restartDeclined: "continuation_disabled" as const } : {}),
    status: "cancelled" as const,
    queuePosition: null,
    completedAt: now,
    ...(handoff?.runIds.includes(run.id) ? { restartHandoffPending: true } : {}),
  };
}

export function cancelledRuntimeDetail(trigger: "startup" | "shutdown") {
  return `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
}

export const restartRunUpdates = Effect.fn("RestartRunRecovery.updates")(function* <E>(input: {
  threadId: ThreadId;
  runs: ReadonlyArray<OrchestrationV2Run>;
  source: OrchestrationV2Run | undefined;
  continueAfterRestart: boolean;
  now: DateTime.Utc;
  handoff: ServerRestartHandoff | undefined;
  allocateEventId: () => Effect.Effect<EventId, E>;
}) {
  const declined = !input.continueAfterRestart ? input.source : undefined;
  const runs =
    declined !== undefined && !input.runs.some((run) => run.id === declined.id)
      ? [...input.runs, declined]
      : input.runs;
  const events: OrchestrationV2DomainEvent[] = [];
  for (const run of runs) {
    events.push({
      id: yield* input.allocateEventId(),
      type: "run.updated",
      threadId: input.threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: input.now,
      payload: input.runs.includes(run)
        ? cancelledRestartRun(run, input.now, input.handoff, declined?.id === run.id)
        : { ...run, restartDeclined: "continuation_disabled" },
    });
  }
  return events;
});
