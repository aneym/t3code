import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type RunId,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadContinueNothingToContinueError extends Schema.TaggedError<ThreadContinueNothingToContinueError>()(
  "ThreadContinueNothingToContinueError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "Nothing to continue: the thread is not stopped by a usage limit or an interruption, and its queue is not held.";
  }
}

export interface ThreadContinueResult {
  readonly sequence: number;
  readonly continuedRunId: RunId | null;
  readonly queueResumed: boolean;
}

const holdsQueue = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs.some((run) => run.status === "queued" && run.queueHeld === true);

export const continueThread = Effect.fn("ThreadContinue.continueThread")(function* (
  threads: ThreadManagement.ThreadManagementService["Service"],
  input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly createdBy: OrchestrationV2Actor;
    readonly creationSource: OrchestrationV2CreationSource;
  },
) {
  const { runs } = yield* threads.getThreadRecords(input.threadId, ["runs"]);
  const latest = latestExecutedRun(runs);
  const { turnItems } =
    latest?.status === "failed"
      ? yield* threads.getThreadRecords(input.threadId, ["turnItems"], {
          turnItemRunId: latest.id,
        })
      : { turnItems: [] };
  const continuedRunId =
    latest?.status === "interrupted"
      ? latest.id
      : (usageLimitBlockedRun(runs, turnItems, null)?.id ?? null);
  const queueHeld = holdsQueue(runs);
  if (continuedRunId === null && !queueHeld)
    return yield* new ThreadContinueNothingToContinueError({ threadId: input.threadId });
  let sequence = 0;
  if (continuedRunId !== null) {
    const result = yield* threads.dispatch({
      type: "message.dispatch",
      commandId: input.commandId,
      messageId: MessageId.make(`continue:${input.commandId}`),
      threadId: input.threadId,
      manualContinuationOfRunId: continuedRunId,
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });
    sequence = result.sequence;
  }
  if (queueHeld) {
    const result = yield* threads.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`${input.commandId}:queue`),
      threadId: input.threadId,
    });
    sequence = result.sequence;
  }
  return { sequence, continuedRunId, queueResumed: queueHeld } satisfies ThreadContinueResult;
});
