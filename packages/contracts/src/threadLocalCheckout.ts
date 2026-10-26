import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Moves a worktree thread's branch and uncommitted changes into the project's local checkout. */
export const ThreadMoveToLocalCheckoutInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadMoveToLocalCheckoutInput = typeof ThreadMoveToLocalCheckoutInput.Type;

export const ThreadMoveToLocalCheckoutResult = Schema.Struct({
  branch: TrimmedNonEmptyString,
  localCheckoutPath: TrimmedNonEmptyString,
  previousWorktreePath: TrimmedNonEmptyString,
  /** The local checkout's branch before the move, or null when it was on a detached HEAD. */
  previousLocalBranch: Schema.NullOr(TrimmedNonEmptyString),
  carriedChanges: Schema.Boolean,
  /**
   * The worktree folder is never deleted: it stays on a detached HEAD with its own copy of the
   * changes, for storage cleanup to remove. False when the folder was already gone.
   */
  previousWorktreeKept: Schema.Boolean,
});
export type ThreadMoveToLocalCheckoutResult = typeof ThreadMoveToLocalCheckoutResult.Type;

export class ThreadMoveToLocalCheckoutError extends Schema.TaggedError<ThreadMoveToLocalCheckoutError>()(
  "ThreadMoveToLocalCheckoutError",
  {
    code: Schema.Literals([
      "thread_not_found",
      "project_not_found",
      "not_in_worktree",
      "thread_archived",
      "thread_running",
      "move_in_progress",
      "not_a_repository",
      "worktree_detached",
      "worktree_shared",
      "worktree_conflicted",
      "worktree_operation_in_progress",
      "submodule_changes",
      "hidden_changes",
      "different_repository",
      "local_checkout_dirty",
      "local_checkout_busy",
      "local_operation_in_progress",
      "untracked_collision",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}
