import {
  CommandId,
  type GitCommandError,
  ThreadMoveToLocalCheckoutError,
  type ThreadId,
  type ThreadMoveToLocalCheckoutResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type * as PlatformError from "effect/PlatformError";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";

type ErrorCode = ThreadMoveToLocalCheckoutError["code"];

export interface MoveThreadToLocalCheckoutInput {
  readonly threadId: ThreadId;
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

/**
 * Paths of submodules with new commits, modified content or untracked files, from
 * `git status --porcelain=v2 -z`. Their edits live in the submodule's own repository.
 */
export function parseDirtySubmodules(stdout: string): ReadonlyArray<string> {
  const fields = stdout.split("\0");
  const dirty: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const kind = field[0];
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    const parts = field.split(" ");
    const sub = parts[2] ?? "N...";
    // Ordinary entries have 9 fields before the path, renames 10, unmerged 11.
    const pathStart = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    if (sub[0] === "S" && sub !== "S...") dirty.push(parts.slice(pathStart).join(" "));
    if (kind === "2") index += 1;
  }
  return dirty;
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
  const fileSystem = yield* FileSystem.FileSystem;
  // Key by the real path so a symlinked project root shares the guard with its target.
  const checkoutKey = yield* fileSystem
    .realPath(project.workspaceRoot)
    .pipe(Effect.orElseSucceed(() => path.resolve(project.workspaceRoot)));
  // Uninterruptible: a client disconnect between git steps would leave both checkouts half
  // switched. Every step is bounded git work.
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      if (!(yield* acquire(input.threadId, checkoutKey))) {
        return yield* fail(
          "move_in_progress",
          "Another move into this project's local checkout is already running. Try again when it finishes.",
        );
      }
      return yield* performMove(input, project.workspaceRoot).pipe(
        Effect.ensuring(release(input.threadId, checkoutKey)),
      );
    }),
  );
});

const OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
];

/**
 * The worktree itself is never modified before the thread is re-pointed: tracked changes are
 * snapshotted with `git stash create` (no ref, nothing reset) and untracked files are copied.
 * Detaching its HEAD keeps every change in place, so rolling back only re-attaches it.
 */
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
  const runWithStdin = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    stdin: string,
  ) => git.execute({ operation: `ThreadLocalCheckout.${operation}`, cwd, args, stdin });
  const isSymlink = (target: string) =>
    fileSystem.readLink(target).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  // Dangling symlinks count: `exists` follows links and would miss them.
  const occupied = Effect.fn("ThreadLocalCheckout.occupied")(function* (target: string) {
    if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))) return true;
    return yield* isSymlink(target);
  });
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const currentBranch = (cwd: string) =>
    probe("currentBranch", cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
    );
  const currentHead = (cwd: string) =>
    run("currentHead", cwd, ["rev-parse", "HEAD"]).pipe(
      Effect.map((result) => result.stdout.trim()),
    );

  const projection = yield* threadManagement
    .getThreadRecords(input.threadId, [])
    .pipe(operationFailed(`Unable to read thread ${input.threadId}`));
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
  const localReal = yield* realPath(localPath);
  const worktreeReal = yield* realPath(worktreePath);
  if (worktreeReal === localReal) {
    return yield* fail("not_in_worktree", "The thread's workspace is already the local checkout.");
  }

  const projectThreads = yield* threadManagement
    .listProjectThreads({ projectId: thread.projectId, includeSubagents: true })
    .pipe(operationFailed("Unable to list the project's threads"));
  const archivedThreads = yield* threadManagement.getShellSnapshot({ location: "archive" }).pipe(
    Effect.map((snapshot) =>
      [...snapshot.threads, ...snapshot.archivedThreads].filter(
        (candidate) => candidate.projectId === thread.projectId,
      ),
    ),
    operationFailed("Unable to list the project's archived threads"),
  );
  const self = projectThreads.find((candidate) => candidate.id === input.threadId);
  if (!input.allowActiveRun && self?.activeRunId) {
    return yield* fail(
      "thread_running",
      "The thread is working. Stop it or wait for the turn to finish, then move it.",
    );
  }

  // Stored paths may be relative, carry a trailing slash, or go through a symlink.
  const others = [...projectThreads, ...archivedThreads].filter(
    (candidate, index, all) =>
      candidate.id !== input.threadId &&
      all.findIndex((other) => other.id === candidate.id) === index,
  );
  const workspaceOf = Effect.fn("ThreadLocalCheckout.workspaceOf")(function* (
    candidate: (typeof others)[number],
  ) {
    return candidate.worktreePath === null ? localReal : yield* realPath(candidate.worktreePath);
  });
  const runningLocal: Array<(typeof others)[number]> = [];
  const sharers: Array<(typeof others)[number]> = [];
  for (const candidate of others) {
    const workspace = yield* workspaceOf(candidate);
    if (
      workspace === localReal &&
      candidate.archivedAt === null &&
      candidate.activeRunId !== null
    ) {
      runningLocal.push(candidate);
    }
    if (workspace === worktreeReal) sharers.push(candidate);
  }
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

  const previousLocalBranch = yield* currentBranch(localPath).pipe(
    operationFailed("Unable to read the local checkout's branch"),
  );
  const previousLocalHead = yield* currentHead(localPath).pipe(
    Effect.mapError(
      () =>
        new ThreadMoveToLocalCheckoutError({
          code: "operation_failed",
          message: "The local checkout has no commits yet. Make a first commit, then move.",
        }),
    ),
  );

  const operationInProgress = Effect.fn("ThreadLocalCheckout.operationInProgress")(function* (
    cwd: string,
  ) {
    for (const marker of OPERATION_MARKERS) {
      const markerPath = (yield* run("gitPath", cwd, [
        "rev-parse",
        "--git-path",
        marker,
      ])).stdout.trim();
      if (yield* occupied(path.resolve(cwd, markerPath))) return true;
    }
    return false;
  });
  const statusOf = (operation: string, cwd: string) =>
    run(operation, cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).pipe(
      Effect.map((result) => parsePorcelainStatus(result.stdout)),
    );

  // The first folder on the way to `relative` that is a symlink or not a folder; writing through
  // a symlinked folder would land outside the checkout.
  const blockedAncestor = Effect.fn("ThreadLocalCheckout.blockedAncestor")(function* (
    relative: string,
  ) {
    const parts = relative.split("/").slice(0, -1);
    let cursor = localPath;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      if (yield* isSymlink(cursor)) return cursor;
      const info = yield* fileSystem.stat(cursor).pipe(Effect.option);
      if (Option.isNone(info)) return null;
      if (info.value.type !== "Directory") return cursor;
    }
    return null;
  });

  if (
    yield* operationInProgress(localPath).pipe(
      operationFailed("Unable to inspect the local checkout"),
    )
  ) {
    return yield* fail(
      "local_operation_in_progress",
      "The local checkout is in the middle of a merge, rebase, cherry-pick, revert or bisect. Finish or abort it first.",
    );
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

  const worktreeOnDisk = yield* fileSystem
    .exists(worktreePath)
    .pipe(Effect.orElseSucceed(() => false));
  let branch: string;
  let trackedSnapshot: string | null = null;
  let untrackedPaths: ReadonlyArray<string> = [];
  if (worktreeOnDisk) {
    const worktreeBranch = yield* currentBranch(worktreePath).pipe(
      operationFailed("Unable to read the worktree's branch"),
    );
    if (worktreeBranch === null) {
      return yield* fail(
        "worktree_detached",
        "The worktree is on a detached HEAD. Check out a branch in it first.",
      );
    }
    branch = worktreeBranch;
    const worktreeChanges = yield* statusOf("worktreeStatus", worktreePath).pipe(
      operationFailed("Unable to read the worktree's status"),
    );
    const conflicted = worktreeChanges.filter((entry) => UNMERGED_CODES.has(entry.code));
    if (conflicted.length > 0) {
      return yield* fail(
        "worktree_conflicted",
        `The worktree has unresolved conflicts (${describePaths(conflicted)}). Resolve them first.`,
      );
    }
    // Git hides edits to files flagged assume-unchanged, and to skip-worktree files that exist on
    // disk; status, the snapshot and the copy would all miss them. Sparse-checkout entries are
    // skip-worktree files that are absent, which is fine.
    const flaggedEntries = yield* run("indexFlags", worktreePath, ["ls-files", "-v", "-z"]).pipe(
      Effect.map((result) => result.stdout.split("\0").filter((field) => field.length > 2)),
      operationFailed("Unable to read the worktree's index flags"),
    );
    const hidden: string[] = [];
    for (const field of flaggedEntries) {
      const tag = field[0]!;
      const relative = field.slice(2);
      const assumeUnchanged = tag !== tag.toUpperCase();
      if (
        assumeUnchanged ||
        (tag === "S" && (yield* occupied(path.join(worktreePath, relative))))
      ) {
        hidden.push(relative);
      }
    }
    if (hidden.length > 0) {
      return yield* fail(
        "hidden_changes",
        `Git hides edits to files in the worktree marked assume-unchanged or skip-worktree (${hidden.slice(0, 5).join(", ")}), so the move can't carry them. Clear the flags with \`git update-index --no-assume-unchanged --no-skip-worktree <file>\` first.`,
      );
    }
    if (
      yield* operationInProgress(worktreePath).pipe(
        operationFailed("Unable to inspect the worktree"),
      )
    ) {
      return yield* fail(
        "worktree_operation_in_progress",
        "The worktree is in the middle of a merge, rebase, cherry-pick, revert or bisect. Finish or abort it first.",
      );
    }
    const dirtySubmodules = yield* run("submoduleStatus", worktreePath, [
      "status",
      "--porcelain=v2",
      "-z",
      "--ignore-submodules=none",
    ]).pipe(
      Effect.map((result) => parseDirtySubmodules(result.stdout)),
      operationFailed("Unable to read the worktree's submodules"),
    );
    if (dirtySubmodules.length > 0) {
      return yield* fail(
        "submodule_changes",
        `Submodules in the worktree have uncommitted work (${dirtySubmodules.slice(0, 5).join(", ")}). Commit it inside each submodule first; the move can't carry it.`,
      );
    }
    // New files in the worktree, staged or not, must not land on anything already in the checkout.
    const arriving = worktreeChanges.filter(
      (entry) =>
        isUntracked(entry) ||
        entry.code[0] === "A" ||
        entry.code[0] === "R" ||
        entry.code[0] === "C",
    );
    const collisions: StatusEntry[] = [];
    for (const entry of arriving) {
      if (
        (yield* occupied(path.join(localPath, entry.path))) ||
        (yield* blockedAncestor(entry.path)) !== null
      ) {
        collisions.push(entry);
      }
    }
    if (collisions.length > 0) {
      return yield* fail(
        "untracked_collision",
        `The local checkout already has files the worktree would bring over, or a file or symbolic link where it needs a folder (${describePaths(collisions)}). Move or delete them first.`,
      );
    }
    if (worktreeChanges.some((entry) => !isUntracked(entry))) {
      const created = yield* run("snapshot", worktreePath, ["stash", "create"]).pipe(
        operationFailed("Unable to snapshot the worktree's changes"),
      );
      trackedSnapshot = created.stdout.trim() || null;
    }
    untrackedPaths = worktreeChanges.filter(isUntracked).map((entry) => entry.path);
  } else if (thread.branch !== null) {
    branch = thread.branch;
  } else {
    return yield* fail(
      "worktree_detached",
      "The worktree folder is gone and the thread has no branch to move.",
    );
  }
  if (previousLocalBranch === branch) {
    return yield* fail(
      "operation_failed",
      `The local checkout is already on '${branch}', which the worktree also claims. Check \`git worktree list\`.`,
    );
  }
  // Files the branch has that the checkout's HEAD doesn't would land on any untracked or ignored
  // file already at that path; `git switch` refuses, but only with a bare error.
  const arrivingWithBranch = yield* run("branchAdds", localPath, [
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=A",
    "-z",
    previousLocalHead,
    branch,
  ]).pipe(
    Effect.map((result) => result.stdout.split("\0").filter((entry) => entry.length > 0)),
    operationFailed(`Unable to compare the checkout with '${branch}'`),
  );
  const occupiedByLocal: StatusEntry[] = [];
  for (const relative of arrivingWithBranch) {
    if (
      (yield* occupied(path.join(localPath, relative))) ||
      (yield* blockedAncestor(relative)) !== null
    ) {
      occupiedByLocal.push({ code: "??", path: relative });
    }
  }
  if (occupiedByLocal.length > 0) {
    return yield* fail(
      "untracked_collision",
      `The local checkout has untracked or ignored files where '${branch}' has files of its own (${describePaths(occupiedByLocal)}). Move or delete them first.`,
    );
  }

  // Undo steps are registered before the command they undo, and check the real state first:
  // a failing hook can exit nonzero after git already moved HEAD.
  const rollbacks: Array<Effect.Effect<void, GitCommandError | PlatformError.PlatformError>> = [];
  // Local edits made during the move that the rollback left alone.
  const keptLocalEdits: string[] = [];
  const rollback = Effect.fn("ThreadLocalCheckout.rollback")(function* (reason: string) {
    const failures: string[] = [];
    for (const undo of rollbacks.toReversed()) {
      const exit = yield* Effect.exit(undo);
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        const operation =
          typeof error === "object" && error !== null && "operation" in error
            ? `${String(error.operation).replace("ThreadLocalCheckout.", "")}: `
            : "";
        failures.push(`${operation}${errorMessage(error)}`);
      }
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
          const kept =
            keptLocalEdits.length === 0
              ? ""
              : ` Files edited in the local checkout during the move were left as they are: ${keptLocalEdits.slice(0, 5).join(", ")}.`;
          return yield* fail(
            "operation_failed",
            failures.length === 0
              ? `${label} failed, so the thread stayed in its worktree, which still has every change: ${detail}.${kept}`
              : `${label} failed (${detail}), and restoring the previous state also failed: ${failures.join("; ")}. The worktree at '${worktreePath}' still has every change; check both checkouts' branches.${kept}`,
          );
        }),
      ),
    );

  if (worktreeOnDisk) {
    rollbacks.push(
      Effect.gen(function* () {
        if ((yield* currentBranch(worktreePath)) !== branch) {
          yield* run("reattachWorktree", worktreePath, [
            "switch",
            "--quiet",
            "--no-overwrite-ignore",
            branch,
          ]);
        }
      }),
    );
    // Detaching at the same commit leaves the worktree's files and index untouched.
    yield* step(
      "Freeing the branch in the worktree",
      run("detachWorktree", worktreePath, ["switch", "--detach", "--quiet"]),
    );
  } else {
    // A deleted worktree folder still registers the branch as checked out until pruned.
    yield* step("Pruning the missing worktree", run("prune", localPath, ["worktree", "prune"]));
  }

  rollbacks.push(
    Effect.gen(function* () {
      const nowBranch = yield* currentBranch(localPath);
      const nowHead = yield* currentHead(localPath);
      if (nowBranch === previousLocalBranch && nowHead === previousLocalHead) return;
      yield* run(
        "restoreLocal",
        localPath,
        previousLocalBranch === null
          ? ["switch", "--quiet", "--no-overwrite-ignore", "--detach", previousLocalHead]
          : ["switch", "--quiet", "--no-overwrite-ignore", previousLocalBranch],
      );
    }),
  );
  yield* step(
    `Switching the local checkout to '${branch}'`,
    Effect.gen(function* () {
      // Never replace ignored local files (a .env, a build output) with the branch's copy.
      yield* run("switchLocal", localPath, ["switch", "--quiet", "--no-overwrite-ignore", branch]);
      if ((yield* currentBranch(localPath)) !== branch) {
        return yield* fail("operation_failed", `the checkout did not end up on '${branch}'`);
      }
    }),
  );

  const treeEntry = Effect.fn("ThreadLocalCheckout.treeEntry")(function* (
    treeish: string,
    relative: string,
  ) {
    const listed = (yield* run("treeEntry", localPath, ["ls-tree", "-z", treeish, "--", relative]))
      .stdout;
    const field = listed.split("\0")[0] ?? "";
    // "<mode> <type> <oid>\t<path>"
    if (field.length === 0) return null;
    const [mode, , oid] = field.split("\t")[0]!.split(" ");
    return `${mode} ${oid}`;
  });
  const indexEntry = Effect.fn("ThreadLocalCheckout.indexEntry")(function* (relative: string) {
    const listed = (yield* run("indexEntry", localPath, ["ls-files", "-s", "-z", "--", relative]))
      .stdout;
    const field = listed.split("\0")[0] ?? "";
    // "<mode> <oid> <stage>\t<path>"
    if (field.length === 0) return null;
    const [mode, oid] = field.split("\t")[0]!.split(" ");
    return `${mode} ${oid}`;
  });
  const workingEntry = Effect.fn("ThreadLocalCheckout.workingEntry")(function* (relative: string) {
    const target = path.join(localPath, relative);
    const link = yield* fileSystem.readLink(target).pipe(Effect.option);
    // Same "<mode> <oid>" shape as the index and trees, so a mode-only edit also counts.
    if (Option.isSome(link)) {
      const oid = (yield* runWithStdin(
        "hashLink",
        localPath,
        ["hash-object", "--stdin"],
        link.value,
      )).stdout.trim();
      return `120000 ${oid}`;
    }
    const info = yield* fileSystem.stat(target).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return null;
    const oid = (yield* run("hashFile", localPath, ["hash-object", "--", relative])).stdout.trim();
    return `${(info.value.mode & 0o111) === 0 ? "100644" : "100755"} ${oid}`;
  });
  // Reverts only paths whose index and working copy still hold exactly what the snapshot wrote,
  // so an edit made in the checkout during the move survives the rollback.
  const undoSnapshot = Effect.fn("ThreadLocalCheckout.undoSnapshot")(function* (snapshot: string) {
    const changed = new Set<string>();
    for (const against of [snapshot, `${snapshot}^2`]) {
      const listed = yield* run("snapshotPaths", localPath, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        "HEAD",
        against,
      ]);
      for (const relative of listed.stdout.split("\0"))
        if (relative.length > 0) changed.add(relative);
    }
    const added: string[] = [];
    const existing: string[] = [];
    for (const relative of changed) {
      const ours =
        (yield* indexEntry(relative)) === (yield* treeEntry(`${snapshot}^2`, relative)) &&
        (yield* workingEntry(relative)) === (yield* treeEntry(snapshot, relative));
      const atHead = yield* treeEntry("HEAD", relative);
      const untouched =
        (yield* indexEntry(relative)) === atHead && (yield* workingEntry(relative)) === atHead;
      if (untouched) continue;
      if (!ours) {
        keptLocalEdits.push(relative);
        continue;
      }
      if (atHead === null) added.push(relative);
      else existing.push(relative);
    }
    for (const relative of added) {
      yield* run("unstageAdded", localPath, [
        "rm",
        "-q",
        "--cached",
        // Verified above to hold only what the snapshot wrote; git would refuse staged content
        // that differs from both HEAD and the working copy, which a carried edit always does.
        "--force",
        "--ignore-unmatch",
        "--",
        relative,
      ]);
      yield* fileSystem.remove(path.join(localPath, relative), { force: true });
      let parent = path.dirname(path.join(localPath, relative));
      while (parent !== localPath && parent.startsWith(`${localPath}${path.sep}`)) {
        const entries = yield* fileSystem
          .readDirectory(parent)
          .pipe(Effect.orElseSucceed(() => ["?"]));
        if (entries.length > 0) break;
        yield* fileSystem.remove(parent);
        parent = path.dirname(parent);
      }
    }
    if (existing.length > 0) {
      yield* run("restoreExisting", localPath, ["checkout", "HEAD", "--", ...existing]);
    }
  });

  // Paths this move created in the checkout, with what it wrote. Rollback removes a file only while
  // it still holds exactly that, so an edit made to it in the meantime survives.
  const createdFiles: Array<{ readonly relative: string; written: string | null }> = [];
  const createdDirectories: string[] = [];
  rollbacks.push(
    Effect.gen(function* () {
      if (trackedSnapshot !== null) yield* undoSnapshot(trackedSnapshot);
      for (const file of createdFiles.toReversed()) {
        const now = yield* workingEntry(file.relative).pipe(
          Effect.orElseSucceed(() => "unreadable"),
        );
        if (file.written !== null && now !== file.written) {
          if (now !== null) keptLocalEdits.push(file.relative);
          continue;
        }
        // `written` is null only when the copy failed partway, leaving a partial file of ours.
        yield* fileSystem.remove(path.join(localPath, file.relative), { force: true });
      }
      for (const directory of createdDirectories.toReversed()) {
        const entries = yield* fileSystem
          .readDirectory(directory)
          .pipe(Effect.orElseSucceed(() => ["?"]));
        if (entries.length === 0) yield* fileSystem.remove(directory);
      }
    }),
  );
  const ensureDirectory = Effect.fn("ThreadLocalCheckout.ensureDirectory")(function* (
    directory: string,
  ) {
    const missing: string[] = [];
    let cursor = directory;
    while (!(yield* occupied(cursor))) {
      missing.push(cursor);
      cursor = path.dirname(cursor);
    }
    for (const created of missing.toReversed()) {
      yield* fileSystem.makeDirectory(created);
      createdDirectories.push(created);
    }
  });
  if (trackedSnapshot !== null) {
    const snapshot = trackedSnapshot;
    yield* step(
      "Restoring the changes in the local checkout",
      run("applySnapshot", localPath, ["stash", "apply", "--index", snapshot]),
    );
  }
  if (untrackedPaths.length > 0) {
    yield* step(
      "Copying the worktree's new files",
      Effect.forEach(
        untrackedPaths,
        (relative) =>
          Effect.gen(function* () {
            const source = path.join(worktreePath, relative);
            const target = path.join(localPath, relative);
            if ((yield* blockedAncestor(relative)) !== null) {
              return yield* fail(
                "operation_failed",
                `a symbolic link or file appeared where '${relative}' needs a folder`,
              );
            }
            yield* ensureDirectory(path.dirname(target));
            const parentReal = yield* realPath(path.dirname(target));
            if (parentReal !== localReal && !parentReal.startsWith(`${localReal}${path.sep}`)) {
              return yield* fail(
                "operation_failed",
                `'${relative}' would land outside the checkout`,
              );
            }
            const link = yield* fileSystem.readLink(source).pipe(Effect.option);
            const created = { relative, written: null as string | null };
            if (Option.isSome(link)) {
              // symlink() refuses an existing path, so nothing that appeared meanwhile is replaced.
              yield* fileSystem.symlink(link.value, target);
              createdFiles.push(created);
            } else {
              // Write through an exclusively created file: anything that appears at the path
              // meanwhile makes this fail instead of being overwritten. The mode is set at
              // creation only; a later chmod by path could follow a swapped-in symlink.
              const mode = (yield* fileSystem.stat(source)).mode & 0o777;
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const output = yield* fileSystem.open(target, { flag: "wx", mode });
                  createdFiles.push(created);
                  const landed = yield* realPath(target);
                  if (!landed.startsWith(`${localReal}${path.sep}`)) {
                    return yield* fail(
                      "operation_failed",
                      `'${relative}' would land outside the checkout`,
                    );
                  }
                  yield* fileSystem
                    .stream(source)
                    .pipe(Stream.runForEach((chunk) => output.writeAll(chunk)));
                }),
              );
            }
            created.written = yield* workingEntry(relative);
          }),
        { discard: true },
      ),
    );
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
    carriedChanges: trackedSnapshot !== null || untrackedPaths.length > 0,
    previousWorktreeKept: worktreeOnDisk,
  };
  return result;
});
