import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export const ThreadMoveToLocalCheckoutErrorCode = Schema.Literals([
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
]);
export type ThreadMoveToLocalCheckoutErrorCode = typeof ThreadMoveToLocalCheckoutErrorCode.Type;

export const ThreadMoveToLocalCheckoutFileChange = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["staged", "unstaged", "staged_and_unstaged", "untracked"]),
});
export type ThreadMoveToLocalCheckoutFileChange = typeof ThreadMoveToLocalCheckoutFileChange.Type;

/** What a move would do right now, without doing it; `blocker` explains why it can't. */
export const ThreadMoveToLocalCheckoutPreview = Schema.Struct({
  branch: Schema.NullOr(TrimmedNonEmptyString),
  localCheckoutPath: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  currentLocalBranch: Schema.NullOr(TrimmedNonEmptyString),
  /** Commits on `branch` that the checkout's current commit lacks, and the reverse. */
  commitsAhead: Schema.NullOr(NonNegativeInt),
  commitsBehind: Schema.NullOr(NonNegativeInt),
  changes: Schema.Struct({
    staged: NonNegativeInt,
    unstaged: NonNegativeInt,
    untracked: NonNegativeInt,
  }),
  files: Schema.Array(ThreadMoveToLocalCheckoutFileChange),
  filesOmitted: NonNegativeInt,
  /** False when the worktree folder is already gone. */
  worktreeOnDisk: Schema.Boolean,
  /** An earlier move of this thread was interrupted; moving again undoes it first. */
  interruptedMove: Schema.Boolean,
  blocker: Schema.NullOr(
    Schema.Struct({ code: ThreadMoveToLocalCheckoutErrorCode, message: Schema.String }),
  ),
});
export type ThreadMoveToLocalCheckoutPreview = typeof ThreadMoveToLocalCheckoutPreview.Type;

export class ThreadMoveToLocalCheckoutError extends Schema.TaggedError<ThreadMoveToLocalCheckoutError>()(
  "ThreadMoveToLocalCheckoutError",
  {
    code: ThreadMoveToLocalCheckoutErrorCode,
    message: Schema.String,
  },
) {}
