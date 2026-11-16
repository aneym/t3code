import type { OrchestrationV2TaskCancel, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { taskCancelCommand } from "../orchestration-v2/TaskCancel.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";

export const recordTaskCancelAndStop = Effect.fn("OrchestratorMcpService.recordTaskCancelAndStop")(
  function* (
    threadManagement: ThreadManagementServiceShape,
    input: {
      readonly commandId: string;
      readonly threadId: ThreadId;
      readonly cancel: Omit<OrchestrationV2TaskCancel, "cancelledAt">;
    },
  ) {
    const cancelledAt = DateTime.formatIso(yield* DateTime.now);
    yield* threadManagement.dispatch(
      taskCancelCommand(input.commandId, input.threadId, { ...input.cancel, cancelledAt }),
    );
    const stopped = yield* threadManagement.forceStopThread({ threadId: input.threadId });
    yield* Effect.logInfo("orchestrator-mcp.task-cancel-stopped", {
      threadId: input.threadId,
      taskId: input.cancel.taskId,
      outcome: stopped.outcome,
    });
  },
  (effect, _threadManagement, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestrator-mcp.task-cancel-stop-failed", {
          threadId: input.threadId,
          cause,
        }),
      ),
    ),
);
