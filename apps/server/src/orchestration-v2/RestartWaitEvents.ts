import type { OrchestrationV2Run, RunId, ThreadId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { OrchestratorV2 } from "./Orchestrator.ts";

export function restartWaitEvents(
  orchestrator: OrchestratorV2["Service"],
  input: {
    threadId: ThreadId;
    afterSequence: number;
    untilDelegatedWorkSettled: boolean;
    pending: boolean;
    run: OrchestrationV2Run;
    selectedRunId: RunId;
  },
) {
  return Stream.merge(
    Stream.mergeAll(
      [
        "run.updated",
        "thread.deleted",
        ...(input.untilDelegatedWorkSettled
          ? (["subagent.updated", "provider-thread.updated"] as const)
          : []),
      ].map((eventType) =>
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          eventType: eventType as
            | "run.updated"
            | "thread.deleted"
            | "subagent.updated"
            | "provider-thread.updated",
        }),
      ),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.filter(
        (stored) =>
          input.untilDelegatedWorkSettled ||
          stored.event.type !== "run.updated" ||
          stored.event.payload.id === input.selectedRunId ||
          stored.event.payload.restartContinuationOfRunId !== undefined,
      ),
    ),
    input.pending
      ? Stream.fromEffect(orchestrator.awaitRestartContinuation(input.run))
      : Stream.empty,
  );
}
