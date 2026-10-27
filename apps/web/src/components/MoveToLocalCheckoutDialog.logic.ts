import type {
  ThreadMoveToLocalCheckoutFileChange,
  ThreadMoveToLocalCheckoutPreview,
} from "@t3tools/contracts";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "2 staged, 1 unstaged, 3 new files", or null when nothing comes along. */
export function describeChanges(
  changes: ThreadMoveToLocalCheckoutPreview["changes"],
): string | null {
  const parts = [
    changes.staged > 0 ? `${changes.staged} staged` : null,
    changes.unstaged > 0 ? `${changes.unstaged} unstaged` : null,
    changes.untracked > 0 ? plural(changes.untracked, "new file", "new files") : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

/** How the thread's branch relates to the commit the checkout is on now. */
export function describeBranchDistance(
  preview: Pick<
    ThreadMoveToLocalCheckoutPreview,
    "commitsAhead" | "commitsBehind" | "currentLocalBranch"
  >,
): string | null {
  const { commitsAhead: ahead, commitsBehind: behind } = preview;
  if (ahead === null || behind === null) return null;
  const base = preview.currentLocalBranch ?? "the current commit";
  if (ahead === 0 && behind === 0) return `Same commit as ${base}`;
  if (behind === 0) return `${plural(ahead, "commit", "commits")} ahead of ${base}`;
  if (ahead === 0) return `${plural(behind, "commit", "commits")} behind ${base}`;
  return `${plural(ahead, "commit", "commits")} ahead of ${base}, ${behind} behind`;
}

export const FILE_CHANGE_LABEL: Record<ThreadMoveToLocalCheckoutFileChange["change"], string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  staged_and_unstaged: "Staged + unstaged",
  untracked: "New",
};

/** The success toast's description: where the thread is now and what came with it. */
export function describeMoveResult(result: {
  readonly branch: string;
  readonly carriedChanges: boolean;
  readonly previousWorktreeKept: boolean;
}): string {
  return [
    `Now on ${result.branch}.`,
    result.carriedChanges ? "Your uncommitted changes came along." : null,
    result.previousWorktreeKept ? "The old worktree folder keeps its own copy." : null,
  ]
    .filter((line) => line !== null)
    .join(" ");
}

/** Readable text for a failed request, including an older server that lacks the move. */
export function moveErrorMessage(error: unknown, fallback: string): string {
  if (String(error).includes("Unknown request tag")) {
    return "This T3 Code server can't move threads yet. Update it, then try again.";
  }
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
