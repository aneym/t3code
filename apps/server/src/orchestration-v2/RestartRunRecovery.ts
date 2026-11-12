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
    restartHandoffPending: handoff?.runIds.includes(run.id) === true && !declined,
    status: "cancelled" as const,
    queuePosition: null,
    completedAt: now,
  };
}

export function cancelledRuntimeDetail(trigger: "startup" | "shutdown") {
  return `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
}

export const restartRunUpdates = Effect.fn("RestartRunRecovery.updates")(function* <E>(input: {
  threadId: ThreadId;
  runs: ReadonlyArray<OrchestrationV2Run>;
  allRuns: ReadonlyArray<OrchestrationV2Run>;
  source: OrchestrationV2Run | undefined;
  continueAfterRestart: boolean;
  now: DateTime.Utc;
  handoff: ServerRestartHandoff | undefined;
  allocateEventId: () => Effect.Effect<EventId, E>;
}) {
  const declined = !input.continueAfterRestart ? input.source : undefined;
  const terminalCovered = input.allRuns.filter(
    (run) =>
      !input.runs.includes(run) &&
      run.id !== declined?.id &&
      ((run.status === "cancelled" && input.handoff?.runIds.includes(run.id)) ||
        run.restartHandoffPending === true),
  );
  const changedRuns =
    declined !== undefined && !input.runs.some((run) => run.id === declined.id)
      ? [...input.runs, declined]
      : input.runs;
  const events: OrchestrationV2DomainEvent[] = [];
  for (const run of [...changedRuns, ...terminalCovered]) {
    events.push({
      id: yield* input.allocateEventId(),
      type: "run.updated",
      threadId: input.threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: input.now,
      payload: input.runs.includes(run)
        ? cancelledRestartRun(run, input.now, input.handoff, declined?.id === run.id)
        : run.id === declined?.id
          ? { ...run, restartHandoffPending: false }
          : { ...run, restartHandoffPending: input.handoff?.runIds.includes(run.id) === true },
    });
  }
  return events;
});
