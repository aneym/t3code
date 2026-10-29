import { ThreadId } from "@t3tools/contracts";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

export class ThreadQueueHeldError extends Schema.TaggedError<ThreadQueueHeldError>()(
  "ThreadQueueHeldError",
  { threadId: ThreadId },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = 2;
}
