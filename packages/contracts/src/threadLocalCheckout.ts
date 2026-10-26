import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Moves a worktree thread's branch and uncommitted changes into the project's local checkout. */
export const ThreadMoveToLocalCheckoutInput = Schema.Struct({
  threadId: ThreadId,
  /** Default true. False leaves the worktree folder on a detached HEAD. */
  removeWorktree: Schema.optional(Schema.Boolean),
});
export type ThreadMoveToLocalCheckoutInput = typeof ThreadMoveToLocalCheckoutInput.Type;

export const ThreadMoveToLocalCheckoutWorktreeStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("removed") }),
  Schema.Struct({
    status: Schema.Literal("kept"),
    reason: Schema.Literals(["requested", "shared_with_archived_thread", "missing"]),
  }),
  Schema.Struct({ status: Schema.Literal("remove_failed"), detail: Schema.String }),
]);
export type ThreadMoveToLocalCheckoutWorktreeStatus =
  typeof ThreadMoveToLocalCheckoutWorktreeStatus.Type;

export const ThreadMoveToLocalCheckoutResult = Schema.Struct({
  branch: TrimmedNonEmptyString,
  localCheckoutPath: TrimmedNonEmptyString,
  previousWorktreePath: TrimmedNonEmptyString,
  /** The local checkout's branch before the move, or null when it was on a detached HEAD. */
  previousLocalBranch: Schema.NullOr(TrimmedNonEmptyString),
  carriedChanges: Schema.Boolean,
  worktree: ThreadMoveToLocalCheckoutWorktreeStatus,
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
      "local_checkout_dirty",
      "local_checkout_busy",
      "local_operation_in_progress",
      "untracked_collision",
      "operation_failed",
    ]),
    message: Schema.String,
  },
) {}
