import {
  CommandId,
  type GitCommandError,
  ThreadMoveToLocalCheckoutError,
  type ThreadId,
  type ThreadMoveToLocalCheckoutResult,
  type ThreadMoveToLocalCheckoutWorktreeStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";

type ErrorCode = ThreadMoveToLocalCheckoutError["code"];

export interface MoveThreadToLocalCheckoutInput {
  readonly threadId: ThreadId;
  readonly removeWorktree?: boolean | undefined;
  /** The thread's own agent may move it mid-turn; the workspace change ends that turn. */
  readonly allowActiveRun?: boolean;
}

const fail = (code: ErrorCode, message: string) =>
  Effect.fail(new ThreadMoveToLocalCheckoutError({ code, message }));

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("detail" in error && typeof error.detail === "string" && error.detail.length > 0) {
      return error.detail;
    }
    if ("message" in error) return String(error.message);
  }
  return String(error);
}

const operationFailed = (prefix: string) =>
  Effect.mapError(
    (error: unknown) =>
      new ThreadMoveToLocalCheckoutError({
        code: "operation_failed",
        message: `${prefix}: ${errorMessage(error)}`,
      }),
  );

interface StatusEntry {
  readonly code: string;
  readonly path: string;
}

/** Parses `git status --porcelain=v1 -z`; rename entries carry their source path as a second field. */
export function parsePorcelainStatus(stdout: string): ReadonlyArray<StatusEntry> {
  const fields = stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return entries;
}

const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const isUntracked = (entry: StatusEntry) => entry.code === "??";

function describePaths(entries: ReadonlyArray<StatusEntry>): string {
  const shown = entries.slice(0, 5).map((entry) => entry.path);
  const more = entries.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

// One move per thread and per checkout: two moves into one checkout would race on its branch.
const threadsInFlight = new Set<string>();
const checkoutsInFlight = new Set<string>();

const acquire = (threadId: string, checkout: string) =>
  Effect.sync(() => {
    if (threadsInFlight.has(threadId) || checkoutsInFlight.has(checkout)) return false;
    threadsInFlight.add(threadId);
    checkoutsInFlight.add(checkout);
    return true;
  });

const release = (threadId: string, checkout: string) =>
  Effect.sync(() => {
    threadsInFlight.delete(threadId);
    checkoutsInFlight.delete(checkout);
  });

export const moveThreadToLocalCheckout = Effect.fn("ThreadLocalCheckout.move")(function* (
  input: MoveThreadToLocalCheckoutInput,
) {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const project = yield* Effect.gen(function* () {
    const projection = yield* threadManagement.getThreadRecords(input.threadId, []).pipe(
      Effect.mapError(
        (error) =>
          new ThreadMoveToLocalCheckoutError(
            error._tag === "OrchestratorProjectionError"
              ? { code: "thread_not_found", message: `Thread '${input.threadId}' was not found.` }
              : {
                  code: "operation_failed",
                  message: `Unable to read thread ${input.threadId}: ${errorMessage(error)}`,
                },
          ),
      ),
    );
    if (projection.thread.deletedAt !== null) {
      return yield* fail("thread_not_found", `Thread '${input.threadId}' was not found.`);
    }
    const found = yield* projects
      .getById(projection.thread.projectId)
      .pipe(operationFailed(`Unable to read project ${projection.thread.projectId}`));
    if (Option.isNone(found)) {
      return yield* fail(
        "project_not_found",
        `Project '${projection.thread.projectId}' was not found for thread '${input.threadId}'.`,
      );
    }
    return found.value;
  });

  const path = yield* Path.Path;
  const checkoutKey = path.resolve(project.workspaceRoot);
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (!(yield* acquire(input.threadId, checkoutKey))) {
        return yield* fail(
          "move_in_progress",
          "Another move into this project's local checkout is already running. Try again when it finishes.",
        );
      }
      return yield* restore(performMove(input, project.workspaceRoot)).pipe(
        Effect.ensuring(release(input.threadId, checkoutKey)),
      );
    }),
  );
});

const performMove = Effect.fn("ThreadLocalCheckout.performMove")(function* (
  input: MoveThreadToLocalCheckoutInput,
  localPath: string,
) {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const run = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: `ThreadLocalCheckout.${operation}`, cwd, args });
  const probe = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: `ThreadLocalCheckout.${operation}`,
      cwd,
      args,
      allowNonZeroExit: true,
    });
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  const loadThread = threadManagement
    .getThreadRecords(input.threadId, [])
    .pipe(operationFailed(`Unable to read thread ${input.threadId}`));

  const projection = yield* loadThread;
  const thread = projection.thread;
  const worktreePath = thread.worktreePath;
  if (worktreePath === null) {
    return yield* fail(
      "not_in_worktree",
      `Thread '${input.threadId}' already works in the local checkout.`,
    );
  }
  if (thread.archivedAt !== null) {
    return yield* fail("thread_archived", "Unarchive the thread before moving it.");
  }
  if ((yield* realPath(worktreePath)) === (yield* realPath(localPath))) {
    return yield* fail("not_in_worktree", "The thread's workspace is already the local checkout.");
  }

  const projectThreads = yield* threadManagement
    .listProjectThreads({ projectId: thread.projectId, includeSubagents: true })
    .pipe(operationFailed("Unable to list the project's threads"));
  const self = projectThreads.find((candidate) => candidate.id === input.threadId);
  if (!input.allowActiveRun && self?.activeRunId) {
    return yield* fail(
      "thread_running",
      "The thread is working. Stop it or wait for the turn to finish, then move it.",
    );
  }
  const runningLocal = projectThreads.filter(
    (candidate) =>
      candidate.id !== input.threadId &&
      candidate.worktreePath === null &&
      candidate.archivedAt === null &&
      candidate.activeRunId !== null,
  );
  if (runningLocal.length > 0) {
    return yield* fail(
      "local_checkout_busy",
      `${runningLocal.map((candidate) => `"${candidate.title}"`).join(", ")} ${
        runningLocal.length === 1 ? "is" : "are"
      } working in the local checkout. Switching its branch would change files under ${
        runningLocal.length === 1 ? "it" : "them"
      }. Wait for ${runningLocal.length === 1 ? "it" : "them"} to finish.`,
    );
  }

  const sharers = yield* Effect.forEach(["active", "archive"] as const, (location) =>
    threadManagement.readShellSnapshot({ location, worktreePath }).pipe(
      Effect.flatMap((read) => read),
      Effect.map((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads]),
    ),
  ).pipe(
    Effect.map((groups) => groups.flat().filter((candidate) => candidate.id !== input.threadId)),
    operationFailed("Unable to find threads sharing the worktree"),
  );
  const activeSharers = sharers.filter((candidate) => candidate.archivedAt === null);
  if (activeSharers.length > 0) {
    return yield* fail(
      "worktree_shared",
      `${activeSharers.map((candidate) => `"${candidate.title}"`).join(", ")} also ${
        activeSharers.length === 1 ? "uses" : "use"
      } this worktree. Moving the branch out would leave ${
        activeSharers.length === 1 ? "it" : "them"
      } without one.`,
    );
  }

  if (!(yield* gitWorkflow.isRepository(localPath).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* fail("not_a_repository", `'${localPath}' is not a git repository.`);
  }

  const localBranchResult = yield* probe("localBranch", localPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]).pipe(operationFailed("Unable to read the local checkout's branch"));
  const previousLocalBranch =
    localBranchResult.exitCode === 0 ? localBranchResult.stdout.trim() || null : null;
  const previousLocalHead = (yield* run("localHead", localPath, ["rev-parse", "HEAD"]).pipe(
    operationFailed("Unable to read the local checkout's commit"),
  )).stdout.trim();

  const worktreeOnDisk = yield* exists(worktreePath);
  let branch: string;
  let worktreeHeadDetached = false;
  if (worktreeOnDisk) {
    const worktreeBranch = yield* probe("worktreeBranch", worktreePath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).pipe(operationFailed("Unable to read the worktree's branch"));
    if (worktreeBranch.exitCode === 0 && worktreeBranch.stdout.trim().length > 0) {
      branch = worktreeBranch.stdout.trim();
    } else if (thread.branch !== null && previousLocalBranch === thread.branch) {
      // An earlier move switched the checkout but failed to re-point the thread; finish it.
      branch = thread.branch;
      worktreeHeadDetached = true;
    } else {
      return yield* fail(
        "worktree_detached",
        "The worktree is on a detached HEAD. Check out a branch in it first.",
      );
    }
  } else if (thread.branch !== null) {
    branch = thread.branch;
  } else {
    return yield* fail(
      "worktree_detached",
      "The worktree folder is gone and the thread has no branch to move.",
    );
  }

  const alreadyLocal = previousLocalBranch === branch;

  const statusOf = (operation: string, cwd: string) =>
    run(operation, cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).pipe(
      Effect.map((result) => parsePorcelainStatus(result.stdout)),
    );

  if (!alreadyLocal) {
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ]) {
      const markerPath = (yield* run("gitPath", localPath, [
        "rev-parse",
        "--git-path",
        marker,
      ]).pipe(operationFailed("Unable to inspect the local checkout"))).stdout.trim();
      if (yield* exists(path.resolve(localPath, markerPath))) {
        return yield* fail(
          "local_operation_in_progress",
          "The local checkout is in the middle of a merge, rebase, cherry-pick or revert. Finish or abort it first.",
        );
      }
    }
    const localChanges = (yield* statusOf("localStatus", localPath).pipe(
      operationFailed("Unable to read the local checkout's status"),
    )).filter((entry) => !isUntracked(entry));
    if (localChanges.length > 0) {
      return yield* fail(
        "local_checkout_dirty",
        `The local checkout has uncommitted changes (${describePaths(localChanges)}). Commit or stash them first.`,
      );
    }
  }

  const worktreeChanges =
    worktreeOnDisk && !worktreeHeadDetached
      ? yield* statusOf("worktreeStatus", worktreePath).pipe(
          operationFailed("Unable to read the worktree's status"),
        )
      : [];
  const conflicted = worktreeChanges.filter((entry) => UNMERGED_CODES.has(entry.code));
  if (conflicted.length > 0) {
    return yield* fail(
      "worktree_conflicted",
      `The worktree has unresolved conflicts (${describePaths(conflicted)}). Resolve them first.`,
    );
  }
  const collisions: StatusEntry[] = [];
  for (const entry of worktreeChanges.filter(isUntracked)) {
    if (yield* exists(path.join(localPath, entry.path))) collisions.push(entry);
  }
  if (collisions.length > 0) {
    return yield* fail(
      "untracked_collision",
      `The local checkout already has files the worktree would bring over (${describePaths(collisions)}). Move or delete them first.`,
    );
  }

  const stashMessage = `T3 Code: move thread ${input.threadId} to the local checkout`;
  const readStash = probe("readStash", localPath, [
    "rev-parse",
    "--quiet",
    "--verify",
    "refs/stash",
  ]).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));
  const dropStash = Effect.fn("ThreadLocalCheckout.dropStash")(function* (sha: string) {
    const listed = yield* run("listStash", localPath, ["stash", "list", "--format=%H"]);
    const index = listed.stdout.split("\n").findIndex((line) => line.trim() === sha);
    if (index >= 0) yield* run("dropStash", localPath, ["stash", "drop", `stash@{${index}}`]);
  });

  // The checkout had no tracked changes, and none of the stash's untracked paths existed in it.
  const undoApply = Effect.fn("ThreadLocalCheckout.undoApply")(function* (sha: string) {
    yield* run("undoApply", localPath, ["reset", "--hard", "--quiet", "HEAD"]);
    const untrackedTree = yield* probe("stashUntracked", localPath, [
      "rev-parse",
      "--quiet",
      "--verify",
      `${sha}^3`,
    ]);
    if (untrackedTree.exitCode !== 0) return;
    const listed = yield* run("listStashUntracked", localPath, [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      `${sha}^3`,
    ]);
    const root = path.resolve(localPath);
    for (const relative of listed.stdout.split("\0").filter((entry) => entry.length > 0)) {
      yield* fileSystem.remove(path.join(root, relative), { force: true });
      // Drop folders the apply created, stopping at the first one that still holds something.
      let parent = path.dirname(path.join(root, relative));
      while (parent !== root && parent.startsWith(`${root}${path.sep}`)) {
        const entries = yield* fileSystem
          .readDirectory(parent)
          .pipe(Effect.orElseSucceed(() => ["?"]));
        if (entries.length > 0) break;
        yield* fileSystem.remove(parent).pipe(Effect.ignore);
        parent = path.dirname(parent);
      }
    }
  });

  // Rollback steps run in reverse; each restores the state before its forward step.
  const rollbacks: Array<Effect.Effect<void, GitCommandError | PlatformError.PlatformError>> = [];
  const rollback = Effect.fn("ThreadLocalCheckout.rollback")(function* (reason: string) {
    const failures: string[] = [];
    for (const undo of rollbacks.toReversed()) {
      const exit = yield* Effect.exit(undo);
      if (exit._tag === "Failure") failures.push(errorMessage(Cause.squash(exit.cause)));
    }
    yield* Effect.logWarning("Move to local checkout rolled back", {
      threadId: input.threadId,
      reason,
      failures,
    });
    return failures;
  });
  const step = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const detail = errorMessage(Cause.squash(cause));
          const failures = yield* rollback(`${label}: ${detail}`);
          return yield* fail(
            "operation_failed",
            failures.length === 0
              ? `${label} failed, so nothing was moved: ${detail}`
              : `${label} failed (${detail}), and restoring the previous state also failed: ${failures.join("; ")}. Check the worktree and the local checkout, and \`git stash list\` for "${stashMessage}".`,
          );
        }),
      ),
    );

  let stashSha: string | null = null;
  if (worktreeChanges.length > 0) {
    const before = yield* readStash.pipe(operationFailed("Unable to read the stash"));
    yield* step(
      "Saving the worktree's changes",
      run("stashPush", worktreePath, ["stash", "push", "--include-untracked", "-m", stashMessage]),
    );
    const after = yield* readStash.pipe(operationFailed("Unable to read the stash"));
    if (after !== null && after !== before) {
      stashSha = after;
      const sha = after;
      rollbacks.push(
        Effect.gen(function* () {
          yield* run("restoreWorktreeChanges", worktreePath, ["stash", "apply", "--index", sha]);
          yield* dropStash(sha);
        }),
      );
    }
  }

  if (worktreeOnDisk && !worktreeHeadDetached) {
    yield* step(
      "Freeing the branch in the worktree",
      run("detachWorktree", worktreePath, ["switch", "--detach", "--quiet"]),
    );
    rollbacks.push(
      run("reattachWorktree", worktreePath, ["switch", "--quiet", branch]).pipe(Effect.asVoid),
    );
  } else if (!worktreeOnDisk) {
    // A deleted worktree folder still registers the branch as checked out until pruned.
    yield* step("Pruning the missing worktree", run("prune", localPath, ["worktree", "prune"]));
  }

  if (!alreadyLocal) {
    yield* step(
      `Switching the local checkout to '${branch}'`,
      run("switchLocal", localPath, ["switch", "--quiet", branch]),
    );
    rollbacks.push(
      run(
        "restoreLocal",
        localPath,
        previousLocalBranch === null
          ? ["switch", "--quiet", "--detach", previousLocalHead]
          : ["switch", "--quiet", previousLocalBranch],
      ).pipe(Effect.asVoid),
    );
  }

  if (stashSha !== null) {
    const sha = stashSha;
    yield* step(
      "Restoring the changes in the local checkout",
      run("applyStash", localPath, ["stash", "apply", "--index", sha]).pipe(
        // A failed apply can leave edits behind; the stash still holds them.
        Effect.tapError(() => undoApply(sha).pipe(Effect.ignore)),
      ),
    );
    rollbacks.push(undoApply(sha));
  }

  const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  yield* step(
    "Pointing the thread at the local checkout",
    threadManagement.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`command:move-to-local:${uuid}`),
      threadId: input.threadId,
      branch,
      worktreePath: null,
      expectedWorktreePath: worktreePath,
    }),
  );

  if (stashSha !== null) {
    yield* dropStash(stashSha).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not drop the move's stash entry", {
          threadId: input.threadId,
          detail: errorMessage(Cause.squash(cause)),
        }),
      ),
    );
  }

  let worktree: ThreadMoveToLocalCheckoutWorktreeStatus;
  if (!worktreeOnDisk) {
    worktree = { status: "kept", reason: "missing" };
  } else if (input.removeWorktree === false) {
    worktree = { status: "kept", reason: "requested" };
  } else if (sharers.length > 0) {
    worktree = { status: "kept", reason: "shared_with_archived_thread" };
  } else {
    const removal = yield* Effect.exit(
      gitWorkflow.removeWorktree({ cwd: localPath, path: worktreePath, force: false }),
    );
    worktree =
      removal._tag === "Success"
        ? { status: "removed" }
        : { status: "remove_failed", detail: errorMessage(Cause.squash(removal.cause)) };
  }

  for (const cwd of [localPath, worktreePath]) {
    yield* gitWorkflow.invalidateStatus(cwd);
  }
  yield* vcsStatus
    .refreshStatus(localPath)
    .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

  const result: ThreadMoveToLocalCheckoutResult = {
    branch,
    localCheckoutPath: localPath,
    previousWorktreePath: worktreePath,
    previousLocalBranch,
    carriedChanges: stashSha !== null,
    worktree,
  };
  return result;
});
