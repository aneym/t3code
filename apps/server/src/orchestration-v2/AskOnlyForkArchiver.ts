import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const FINISHED_RUN_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);
const ACTIVE_THREAD_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const archiveAnswered = Effect.fn("AskOnlyForkArchiver.archiveAnswered")(function* (
      event: Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }>,
    ) {
      const thread = yield* projections.getThreadShell(event.threadId);
      if (
        thread === null ||
        thread.lineage.askOnly !== true ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        ACTIVE_THREAD_STATUSES.has(thread.status)
      ) {
        return;
      }
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`server:ask-only-archive:${thread.id}:${event.payload.id}`),
        threadId: thread.id,
      });
      yield* Effect.logInfo("orchestration-v2.ask-only-fork.archived", {
        threadId: thread.id,
        runId: event.payload.id,
      });
    });
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && FINISHED_RUN_STATUSES.has(event.payload.status)
          ? archiveAnswered(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.ask-only-fork.archive-failed", {
                  threadId: event.threadId,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ),
    );
  }),
);
