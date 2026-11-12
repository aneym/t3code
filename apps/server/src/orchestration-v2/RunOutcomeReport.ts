import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2InternalCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { OrchestratorDispatchError } from "./OrchestratorDispatchError.ts";
import { OrchestratorProjectionError } from "./OrchestratorErrors.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

const REPORTABLE = new Set(["preparing", "starting", "running", "waiting"]);

type RunOutcomeReport = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "run.outcome.report" }
>;

export const runOutcomeEvent = Effect.fn("orchestrationV2.runOutcomeReport")(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  command: RunOutcomeReport,
) {
  const { runs } = yield* projectionStore
    .getThreadRecords(command.threadId, ["runs"], { runIds: [command.runId] })
    .pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
      ),
    );
  const run = runs.find((candidate) => candidate.id === command.runId);
  if (run === undefined || !REPORTABLE.has(run.status)) {
    return yield* new OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause: `Run ${command.runId} is not running on thread ${command.threadId}.`,
    });
  }
  const event: Omit<Extract<OrchestrationV2DomainEvent, { type: "run.updated" }>, "id"> = {
    type: "run.updated",
    threadId: command.threadId,
    runId: run.id,
    ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
    providerInstanceId: run.providerInstanceId,
    occurredAt: yield* DateTime.now,
    payload: { ...run, reportedOutcome: command.outcome },
  };
  return event;
});
