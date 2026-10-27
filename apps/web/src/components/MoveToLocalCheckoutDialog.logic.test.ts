import { describe, expect, it } from "vite-plus/test";

import {
  describeBranchDistance,
  describeChanges,
  describeMoveResult,
  moveErrorMessage,
} from "./MoveToLocalCheckoutDialog.logic";

describe("describeChanges", () => {
  it("lists only the kinds of change present", () => {
    expect(describeChanges({ staged: 2, unstaged: 1, untracked: 3 })).toBe(
      "2 staged, 1 unstaged, 3 new files",
    );
    expect(describeChanges({ staged: 0, unstaged: 0, untracked: 1 })).toBe("1 new file");
    expect(describeChanges({ staged: 0, unstaged: 0, untracked: 0 })).toBeNull();
  });
});

describe("describeBranchDistance", () => {
  const distance = (ahead: number | null, behind: number | null, branch: string | null = "main") =>
    describeBranchDistance({
      commitsAhead: ahead,
      commitsBehind: behind,
      currentLocalBranch: branch,
    });

  it("says how far the thread's branch is from the checkout's", () => {
    expect(distance(3, 0)).toBe("3 commits ahead of main");
    expect(distance(1, 0)).toBe("1 commit ahead of main");
    expect(distance(0, 2)).toBe("2 commits behind main");
    expect(distance(2, 5)).toBe("2 commits ahead of main, 5 behind");
    expect(distance(0, 0)).toBe("Same commit as main");
    expect(distance(1, 0, null)).toBe("1 commit ahead of the current commit");
    expect(distance(null, null)).toBeNull();
  });
});

describe("describeMoveResult", () => {
  it("names the branch and what came with it", () => {
    expect(
      describeMoveResult({ branch: "feature", carriedChanges: true, previousWorktreeKept: true }),
    ).toBe(
      "Now on feature. Your uncommitted changes came along. The old worktree folder keeps its own copy.",
    );
    expect(
      describeMoveResult({ branch: "feature", carriedChanges: false, previousWorktreeKept: false }),
    ).toBe("Now on feature.");
  });
});

describe("moveErrorMessage", () => {
  it("tells the user to update a server that doesn't know the move", () => {
    expect(moveErrorMessage("Unknown request tag: git.moveThreadToLocalCheckout", "x")).toBe(
      "This T3 Code server can't move threads yet. Update it, then try again.",
    );
    expect(moveErrorMessage(new Error("Local checkout is dirty"), "x")).toBe(
      "Local checkout is dirty",
    );
    expect(moveErrorMessage({}, "fallback")).toBe("fallback");
  });
});
