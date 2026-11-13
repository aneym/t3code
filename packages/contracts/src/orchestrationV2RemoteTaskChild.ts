import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  NonNegativeInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Where an app-owned task runs when it runs in a linked environment instead
 * of in a child thread here: that environment and the ordinary thread it runs
 * as there. Such a task has no `childThreadId`.
 */
export const OrchestrationV2RemoteTaskChild = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  label: Schema.String,
  /** The title it launched with there; absent on tasks recorded before it was kept. */
  title: Schema.optional(Schema.String),
  /** The run there that carries the task; absent on tasks recorded before it was kept. */
  runId: Schema.optional(RunId),
  /**
   * Nothing is left to stop there: a stop reached it, was refused for good, or the thread
   * or link is gone. A run ending there by itself sets it too, unless the task here was
   * cancelled or stopped and still owes a stop, which its follower keeps sending across
   * restarts. `false`: a Stop here owes one to a task that already had its result.
   */
  stoppedThere: Schema.optional(Schema.Boolean),
  /** Stops owed once the task had its result; the count lands each there once. */
  stopCount: Schema.optional(NonNegativeInt),
  worktreeBase: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationV2RemoteTaskChild = typeof OrchestrationV2RemoteTaskChild.Type;
