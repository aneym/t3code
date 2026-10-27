import {
  CommandId,
  type GitCommandError,
  ThreadMoveToLocalCheckoutError,
  type ProjectId,
  type ThreadId,
  type ThreadMoveToLocalCheckoutPreview,
  type ThreadMoveToLocalCheckoutResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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
  /** Run every check and report what would move, without changing anything. */
  readonly preview?: boolean;
}

type MoveOutcome =
  | { readonly _tag: "moved"; readonly result: ThreadMoveToLocalCheckoutResult }
  | { readonly _tag: "preview"; readonly preview: ThreadMoveToLocalCheckoutPreview };

// Written to the git dir before the first change, removed when the move ends either way.
const MoveJournal = Schema.Struct({
  version: Schema.Literal(1),
  worktreePath: Schema.String,
  sourceRoot: Schema.String,
  branch: Schema.String,
  previousLocalBranch: Schema.NullOr(Schema.String),
  previousLocalHead: Schema.String,
  worktreeHead: Schema.NullOr(Schema.String),
  snapshot: Schema.NullOr(Schema.String),
  untracked: Schema.Array(Schema.String),
});
type MoveJournal = typeof MoveJournal.Type;
const MoveJournalJson = Schema.fromJsonString(MoveJournal);
const encodeJournal = Schema.encodeEffect(MoveJournalJson);
const decodeJournal = Schema.decodeUnknownEffect(MoveJournalJson);

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

const loadTarget = Effect.fn("ThreadLocalCheckout.loadTarget")(function* (threadId: ThreadId) {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const input = { threadId };
  return yield* Effect.gen(function* () {
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
    return { project: found.value, thread: projection.thread };
  });
});

export const moveThreadToLocalCheckout = Effect.fn("ThreadLocalCheckout.move")(function* (
  input: MoveThreadToLocalCheckoutInput,
) {
  const { project } = yield* loadTarget(input.threadId);
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  // Key by the checkout's real repository root: projects in two subfolders of one repository, or
  // a symlinked project root, share one checkout and so one guard.
  const repositoryRoot = yield* git
    .execute({
      operation: "ThreadLocalCheckout.lockRoot",
      cwd: project.workspaceRoot,
      args: ["rev-parse", "--show-toplevel"],
      allowNonZeroExit: true,
    })
    .pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? result.stdout.replace(/\r?\n$/, "") : project.workspaceRoot,
      ),
      Effect.orElseSucceed(() => project.workspaceRoot),
    );
  const platform = yield* HostProcess.Platform;
  const realRoot = yield* fileSystem
    .realPath(repositoryRoot)
    .pipe(Effect.orElseSucceed(() => path.resolve(repositoryRoot)));
  const checkoutKey =
    platform === "win32" || platform === "darwin" ? realRoot.toLowerCase() : realRoot;
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
      const outcome = yield* performMove({ ...input, preview: false }, project.workspaceRoot).pipe(
        Effect.ensuring(release(input.threadId, checkoutKey)),
      );
      return outcome._tag === "moved"
        ? outcome.result
        : yield* Effect.die("move returned a preview");
    }),
  );
});

// Refusals become the preview's blocker; only a missing thread or project is an error.
const PREVIEW_ERRORS = new Set<ErrorCode>(["thread_not_found", "project_not_found"]);

/** Everything a move would do right now, for the confirmation; changes nothing and takes no lock. */
export const previewMoveThreadToLocalCheckout = Effect.fn("ThreadLocalCheckout.preview")(function* (
  input: Pick<MoveThreadToLocalCheckoutInput, "threadId">,
) {
  const { project, thread } = yield* loadTarget(input.threadId);
  return yield* performMove(
    { threadId: input.threadId, preview: true },
    project.workspaceRoot,
  ).pipe(
    Effect.flatMap((outcome) =>
      outcome._tag === "preview" ? Effect.succeed(outcome.preview) : Effect.die("preview moved"),
    ),
    Effect.catchIf(
      (error) => !PREVIEW_ERRORS.has(error.code),
      (error) =>
        Effect.succeed<ThreadMoveToLocalCheckoutPreview>({
          branch: thread.branch,
          localCheckoutPath: project.workspaceRoot,
          worktreePath: thread.worktreePath ?? project.workspaceRoot,
          currentLocalBranch: null,
          commitsAhead: null,
          commitsBehind: null,
          changes: { staged: 0, unstaged: 0, untracked: 0 },
          files: [],
          filesOmitted: 0,
          worktreeOnDisk: true,
          interruptedMove: false,
          blocker: { code: error.code, message: error.message },
        }),
    ),
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
  projectPath: string,
) {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
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
  // Windows and macOS file systems ignore case by default, so two spellings can name one folder.
  const platform = yield* HostProcess.Platform;
  const pathKey = (target: string) =>
    platform === "win32" || platform === "darwin" ? target.toLowerCase() : target;
  const samePath = (left: string, right: string) => pathKey(left) === pathKey(right);
  const within = (folder: string, candidate: string | null) =>
    candidate !== null &&
    (samePath(candidate, folder) || pathKey(candidate).startsWith(pathKey(`${folder}${path.sep}`)));
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
  const localReal = yield* realPath(projectPath);
  const worktreeReal = yield* realPath(worktreePath);
  if (samePath(worktreeReal, localReal)) {
    return yield* fail("not_in_worktree", "The thread's workspace is already the local checkout.");
  }

  // Every active thread in the environment: a thread from another project can still work in
  // this repository or in this worktree.
  const activeThreads = Effect.suspend(() =>
    threadManagement.getShellSnapshot({ location: "active" }),
  ).pipe(
    Effect.map((snapshot) => snapshot.threads.filter((candidate) => candidate.archivedAt === null)),
    operationFailed("Unable to list the environment's threads"),
  );
  const self = (yield* activeThreads).find((candidate) => candidate.id === input.threadId);
  if (!input.allowActiveRun && self?.activeRunId) {
    return yield* fail(
      "thread_running",
      "The thread is working. Stop it or wait for the turn to finish, then move it.",
    );
  }

  // Where a thread works, as a real path. Stored paths may be relative, carry a trailing slash,
  // or go through a symlink; a thread without a worktree works in its own project's folder.
  const projectFolders = new Map<string, string | null>();
  const workspaceOf = Effect.fn("ThreadLocalCheckout.workspaceOf")(function* (candidate: {
    readonly projectId: string;
    readonly worktreePath: string | null;
  }) {
    if (candidate.worktreePath !== null) return yield* realPath(candidate.worktreePath);
    if (!projectFolders.has(candidate.projectId)) {
      const found = yield* projects
        .getById(candidate.projectId as ProjectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      projectFolders.set(
        candidate.projectId,
        Option.isSome(found) ? yield* realPath(found.value.workspaceRoot) : null,
      );
    }
    return projectFolders.get(candidate.projectId) ?? null;
  });
  const titles = (threads: ReadonlyArray<{ readonly title: string }>) =>
    threads.map((candidate) => `"${candidate.title}"`).join(", ");

  // Checked again right before the checkout switches branch, since a thread can start meanwhile.
  const refuseIfLocalBusy = Effect.fn("ThreadLocalCheckout.refuseIfLocalBusy")(function* () {
    const runningLocal: Array<{ readonly title: string }> = [];
    for (const candidate of yield* activeThreads) {
      if (
        candidate.id !== input.threadId &&
        candidate.activeRunId !== null &&
        within(localRootReal, yield* workspaceOf(candidate))
      ) {
        runningLocal.push(candidate);
      }
    }
    if (runningLocal.length > 0) {
      return yield* fail(
        "local_checkout_busy",
        `${titles(runningLocal)} ${
          runningLocal.length === 1 ? "is" : "are"
        } working in the local checkout. Switching its branch would change files under ${
          runningLocal.length === 1 ? "it" : "them"
        }. Wait for ${runningLocal.length === 1 ? "it" : "them"} to finish.`,
      );
    }
  });
  // Any other active thread working anywhere in the worktree would lose its branch.
  const refuseIfWorktreeShared = Effect.fn("ThreadLocalCheckout.refuseIfWorktreeShared")(function* (
    worktreeFolder: string,
  ) {
    const sharers: Array<{ readonly title: string }> = [];
    for (const candidate of yield* activeThreads) {
      // Includes a project whose own folder is this worktree: its local threads work here too.
      if (
        candidate.id !== input.threadId &&
        within(worktreeFolder, yield* workspaceOf(candidate))
      ) {
        sharers.push(candidate);
      }
    }
    if (sharers.length > 0) {
      return yield* fail(
        "worktree_shared",
        `${titles(sharers)} also ${sharers.length === 1 ? "uses" : "use"} this worktree. Moving the branch out would leave ${
          sharers.length === 1 ? "it" : "them"
        } without one.`,
      );
    }
  });

  if (!(yield* gitWorkflow.isRepository(projectPath).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* fail("not_a_repository", `'${projectPath}' is not a git repository.`);
  }
  // A project can sit in a subfolder of its repository. Git reports paths from the repository
  // root, so every git command and file copy below works from the roots of both checkouts.
  const gitRoot = (cwd: string) =>
    run("gitRoot", cwd, ["rev-parse", "--show-toplevel"]).pipe(
      // Only the newline: a folder name can end in a space.
      Effect.map((result) => result.stdout.replace(/\r?\n$/, "")),
    );
  const localPath = yield* gitRoot(projectPath).pipe(
    operationFailed("Unable to find the local checkout's repository root"),
  );
  const localRootReal = yield* realPath(localPath);

  // Local edits made during the move that the rollback left alone.
  const keptLocalEdits: string[] = [];
  // The checkout's tracked state saved just before a rollback touches it, if it touched anything.
  let recoveryCommit: string | null = null;
  // Where a rollback puts files it takes out of the checkout. It renames rather than deletes, so
  // an edit that lands between its checks and the change is kept, not lost.
  let recoveryDirectory: string | null = null;

  // Windows can't show an executable bit, and without symlink support git writes links as plain
  // files (core.fileMode and core.symlinks off), so there the working copy is compared by content.
  const gitFlag = (name: string) =>
    probe("readConfig", localPath, ["config", "--bool", name]).pipe(
      Effect.map((result) => result.stdout.trim() !== "false"),
      Effect.orElseSucceed(() => true),
    );
  const trustsWorkingModes =
    platform !== "win32" ||
    ((yield* gitFlag("core.fileMode")) && (yield* gitFlag("core.symlinks")));
  const sameWorking = (left: string | undefined, right: string | undefined) =>
    trustsWorkingModes || left === undefined || right === undefined
      ? left === right
      : left.split(" ")[1] === right.split(" ")[1];

  // Batched "<mode> <oid>" readers. Paths go to git literally (`a*.txt` is a filename, not a
  // pattern) and in chunks that stay under argument-length limits.
  const PATH_CHUNK = 200;
  const chunked = <T>(items: ReadonlyArray<T>) =>
    Array.from({ length: Math.ceil(items.length / PATH_CHUNK) }, (_, index) =>
      items.slice(index * PATH_CHUNK, (index + 1) * PATH_CHUNK),
    );
  const literal = (args: ReadonlyArray<string>) => ["--literal-pathspecs", ...args];
  const parseEntries = (stdout: string, modeField: number, oidField: number) => {
    const entries = new Map<string, string>();
    for (const field of stdout.split("\0")) {
      const tab = field.indexOf("\t");
      if (tab < 0) continue;
      const parts = field.slice(0, tab).split(" ");
      entries.set(field.slice(tab + 1), `${parts[modeField]} ${parts[oidField]}`);
    }
    return entries;
  };
  const treeEntries = Effect.fn("ThreadLocalCheckout.treeEntries")(function* (
    root: string,
    treeish: string,
    paths: ReadonlyArray<string>,
  ) {
    const entries = new Map<string, string>();
    for (const batch of chunked(paths)) {
      const listed = yield* run(
        "treeEntries",
        root,
        literal(["ls-tree", "-z", treeish, "--", ...batch]),
      );
      // "<mode> <type> <oid>\t<path>"
      for (const [key, value] of parseEntries(listed.stdout, 0, 2)) entries.set(key, value);
    }
    return entries;
  });
  const indexEntries = Effect.fn("ThreadLocalCheckout.indexEntries")(function* (
    root: string,
    paths: ReadonlyArray<string>,
  ) {
    const entries = new Map<string, string>();
    for (const batch of chunked(paths)) {
      const listed = yield* run(
        "indexEntries",
        root,
        literal(["ls-files", "-s", "-z", "--", ...batch]),
      );
      // "<mode> <oid> <stage>\t<path>"
      for (const [key, value] of parseEntries(listed.stdout, 0, 1)) entries.set(key, value);
    }
    return entries;
  });
  // What sits on disk, in the same shape, so a mode-only edit also counts as a difference.
  const workingEntries = Effect.fn("ThreadLocalCheckout.workingEntries")(function* (
    root: string,
    paths: ReadonlyArray<string>,
  ) {
    const entries = new Map<string, string>();
    const files: Array<{ readonly relative: string; readonly mode: string }> = [];
    for (const relative of paths) {
      const target = path.join(root, relative);
      const link = yield* fileSystem.readLink(target).pipe(Effect.option);
      if (Option.isSome(link)) {
        const oid = (yield* runWithStdin(
          "hashLink",
          root,
          ["hash-object", "--stdin"],
          link.value,
        )).stdout.trim();
        entries.set(relative, `120000 ${oid}`);
        continue;
      }
      const info = yield* fileSystem.stat(target).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      files.push({ relative, mode: (info.value.mode & 0o111) === 0 ? "100644" : "100755" });
    }
    for (const batch of chunked(files)) {
      const hashed = yield* run("hashFiles", root, [
        "hash-object",
        "--",
        ...batch.map((file) => file.relative),
      ]);
      const oids = hashed.stdout.trim().split("\n");
      batch.forEach((file, index) => entries.set(file.relative, `${file.mode} ${oids[index]}`));
    }
    return entries;
  });

  // Rollback restores a tracked path only when it holds exactly what the snapshot wrote, and first
  // saves the checkout's tracked state as a commit, so nothing it touches is unrecoverable.
  const saveRecoveryCommit = Effect.fn("ThreadLocalCheckout.saveRecoveryCommit")(function* () {
    if (recoveryCommit !== null) return;
    const created = (yield* run("recoveryCommit", localPath, ["stash", "create"])).stdout.trim();
    if (created.length > 0) recoveryCommit = created;
  });
  const recoveryRoot = Effect.fn("ThreadLocalCheckout.recoveryRoot")(function* () {
    if (recoveryDirectory !== null) return recoveryDirectory;
    const common = (yield* run("commonDir", localPath, [
      "rev-parse",
      "--git-common-dir",
    ])).stdout.replace(/\r?\n$/, "");
    const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    recoveryDirectory = path.join(path.resolve(localPath, common), "t3-move-to-local", id);
    return recoveryDirectory;
  });
  const moveAside = Effect.fn("ThreadLocalCheckout.moveAside")(function* (relative: string) {
    const destination = path.join(yield* recoveryRoot(), "files", relative);
    yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fileSystem.rename(path.join(localPath, relative), destination);
  });
  // Effect has no rmdir, and a recursive remove after an emptiness check could take a file created
  // in between. Renaming the folder aside is atomic and keeps whatever is in it; if the rename
  // fails, an empty folder simply stays.
  const clearEmptyFolder = Effect.fn("ThreadLocalCheckout.clearEmptyFolder")(function* (
    folder: string,
  ) {
    const entries = yield* fileSystem.readDirectory(folder).pipe(Effect.orElseSucceed(() => ["?"]));
    if (entries.length > 0) return false;
    const destination = path.join(
      yield* recoveryRoot(),
      "folders",
      path.relative(localPath, folder),
    );
    yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
    return yield* fileSystem.rename(folder, destination).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });
  const dropEmptyParents = Effect.fn("ThreadLocalCheckout.dropEmptyParents")(function* (
    relative: string,
  ) {
    let parent = path.dirname(path.join(localPath, relative));
    while (parent !== localPath && parent.startsWith(`${localPath}${path.sep}`)) {
      if (!(yield* clearEmptyFolder(parent))) break;
      parent = path.dirname(parent);
    }
  });
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
    const paths = [...changed];
    if (paths.length === 0) return;
    const [index, working, wroteIndex, wroteWorking, atHead] = [
      yield* indexEntries(localPath, paths),
      yield* workingEntries(localPath, paths),
      yield* treeEntries(localPath, `${snapshot}^2`, paths),
      yield* treeEntries(localPath, snapshot, paths),
      yield* treeEntries(localPath, "HEAD", paths),
    ];
    const added: string[] = [];
    const existing: string[] = [];
    for (const relative of paths) {
      const head = atHead.get(relative);
      if (index.get(relative) === head && sameWorking(working.get(relative), head)) continue;
      const ours =
        index.get(relative) === wroteIndex.get(relative) &&
        sameWorking(working.get(relative), wroteWorking.get(relative));
      if (!ours) {
        keptLocalEdits.push(relative);
        continue;
      }
      if (head === undefined) added.push(relative);
      else existing.push(relative);
    }
    if (added.length + existing.length === 0) return;
    yield* saveRecoveryCommit();
    for (const batch of chunked(added)) {
      yield* run(
        "unstageAdded",
        localPath,
        // Verified above to hold only what the snapshot wrote; git would refuse staged content
        // that differs from both HEAD and the working copy, which a carried edit always does.
        literal(["rm", "-q", "--cached", "--force", "--ignore-unmatch", "--", ...batch]),
      );
    }
    for (const relative of added) {
      yield* moveAside(relative);
      yield* dropEmptyParents(relative);
    }
    // Restoring never writes over a path: the current file is renamed aside, the HEAD version is
    // written to a scratch folder, and hard-linked in. link() fails if anything appeared at the
    // path meanwhile, and then the newer file stays.
    for (const batch of chunked(existing)) {
      yield* run("resetIndex", localPath, literal(["reset", "-q", "HEAD", "--", ...batch]));
      const scratch = path.join(yield* recoveryRoot(), "head-versions");
      yield* fileSystem.makeDirectory(scratch, { recursive: true });
      yield* run(
        "writeHeadVersions",
        localPath,
        literal(["checkout-index", "--force", `--prefix=${scratch}${path.sep}`, "--", ...batch]),
      );
      for (const relative of batch) {
        if (yield* occupied(path.join(localPath, relative))) yield* moveAside(relative);
        // Undoing the snapshot may have removed the folder a deleted file lived in.
        yield* fileSystem
          .makeDirectory(path.dirname(path.join(localPath, relative)), { recursive: true })
          .pipe(Effect.ignore);
        const linked = yield* fileSystem
          .link(path.join(scratch, relative), path.join(localPath, relative))
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        if (!linked) keptLocalEdits.push(relative);
      }
      yield* fileSystem.remove(scratch, { recursive: true });
    }
  });

  const commonDirectory = Effect.fn("ThreadLocalCheckout.commonDirectory")(function* (
    root: string,
  ) {
    const common = (yield* run("commonDir", root, [
      "rev-parse",
      "--git-common-dir",
    ])).stdout.replace(/\r?\n$/, "");
    return yield* realPath(path.resolve(root, common));
  });
  const localCommon = yield* commonDirectory(localPath).pipe(
    operationFailed("Unable to read the local checkout's repository"),
  );

  // A crash between git steps leaves a move half done. Its journal lets the next attempt undo what
  // it can show this move did: nothing is reverted unless it still matches the journal.
  const journalFile = path.join(
    localCommon,
    "t3-move-to-local",
    "pending",
    `${encodeURIComponent(input.threadId)}.json`,
  );
  const removeJournal = fileSystem.remove(journalFile, { force: true }).pipe(Effect.ignore);
  const writeJournal = Effect.fn("ThreadLocalCheckout.writeJournal")(function* (
    entry: MoveJournal,
  ) {
    yield* fileSystem.makeDirectory(path.dirname(journalFile), { recursive: true });
    yield* fileSystem.writeFileString(journalFile, yield* encodeJournal(entry));
  });
  const recoverInterruptedMove = Effect.fn("ThreadLocalCheckout.recoverInterruptedMove")(function* (
    entry: MoveJournal,
  ) {
    if ((yield* currentBranch(localPath)) === entry.branch) {
      if (entry.snapshot !== null) yield* undoSnapshot(entry.snapshot);
      if (entry.untracked.length > 0) {
        // Only copies still identical to the worktree's original; anything else stays put.
        const here = yield* workingEntries(localPath, entry.untracked);
        const there = yield* workingEntries(entry.sourceRoot, entry.untracked);
        for (const relative of entry.untracked) {
          const current = here.get(relative);
          if (current !== undefined && sameWorking(current, there.get(relative))) {
            yield* moveAside(relative);
          }
        }
      }
      yield* run(
        "recoverLocal",
        localPath,
        entry.previousLocalBranch === null
          ? ["switch", "--quiet", "--no-overwrite-ignore", "--detach", entry.previousLocalHead]
          : ["switch", "--quiet", "--no-overwrite-ignore", entry.previousLocalBranch],
      );
    }
    const worktreeStill =
      entry.worktreeHead !== null &&
      (yield* fileSystem.exists(entry.sourceRoot).pipe(Effect.orElseSucceed(() => false))) &&
      (yield* currentBranch(entry.sourceRoot)) === null &&
      (yield* currentHead(entry.sourceRoot)) === entry.worktreeHead;
    if (worktreeStill) {
      yield* run("recoverWorktree", entry.sourceRoot, [
        "switch",
        "--quiet",
        "--no-overwrite-ignore",
        entry.branch,
      ]);
    }
    yield* removeJournal;
  });
  const journal = yield* fileSystem
    .readFileString(journalFile)
    .pipe(Effect.flatMap(decodeJournal), Effect.option);
  if (Option.isSome(journal)) {
    if (!samePath(journal.value.worktreePath, worktreePath)) {
      // The thread has moved on: the interrupted move re-pointed it, or it was handed off again.
      if (!input.preview) yield* removeJournal;
    } else if (input.preview) {
      return {
        _tag: "preview",
        preview: {
          branch: journal.value.branch,
          localCheckoutPath: projectPath,
          worktreePath,
          currentLocalBranch: yield* currentBranch(localPath).pipe(
            Effect.orElseSucceed(() => null),
          ),
          commitsAhead: null,
          commitsBehind: null,
          changes: { staged: 0, unstaged: 0, untracked: 0 },
          files: [],
          filesOmitted: 0,
          worktreeOnDisk: yield* fileSystem
            .exists(worktreePath)
            .pipe(Effect.orElseSucceed(() => false)),
          interruptedMove: true,
          blocker: null,
        },
      } satisfies MoveOutcome;
    } else {
      yield* recoverInterruptedMove(journal.value).pipe(
        Effect.mapError(
          (error) =>
            new ThreadMoveToLocalCheckoutError({
              code: "operation_failed",
              message: `An earlier move of this thread was interrupted, and undoing it failed: ${errorMessage(error)}. The worktree at '${worktreePath}' still has every change.${
                recoveryDirectory === null
                  ? ""
                  : ` Anything taken out of the checkout is under '${recoveryDirectory}'.`
              }`,
            }),
        ),
      );
    }
  }

  yield* refuseIfLocalBusy();

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
  let worktreeEntries: ReadonlyArray<StatusEntry> = [];
  let sourceRoot = worktreePath;
  if (worktreeOnDisk) {
    sourceRoot = yield* gitRoot(worktreePath).pipe(
      operationFailed("Unable to find the worktree's repository root"),
    );
    // A branch only moves between checkouts of one repository; another repository's branch of the
    // same name is a different branch.
    const sourceCommon = yield* commonDirectory(sourceRoot).pipe(
      operationFailed("Unable to read the worktree's repository"),
    );
    yield* refuseIfWorktreeShared(yield* realPath(sourceRoot));
    if (!samePath(localCommon, sourceCommon)) {
      return yield* fail(
        "different_repository",
        `The worktree at '${worktreePath}' belongs to a different repository than the project folder.`,
      );
    }
    const worktreeBranch = yield* currentBranch(sourceRoot).pipe(
      operationFailed("Unable to read the worktree's branch"),
    );
    if (worktreeBranch === null) {
      return yield* fail(
        "worktree_detached",
        "The worktree is on a detached HEAD. Check out a branch in it first.",
      );
    }
    branch = worktreeBranch;
    const worktreeChanges = yield* statusOf("worktreeStatus", sourceRoot).pipe(
      operationFailed("Unable to read the worktree's status"),
    );
    worktreeEntries = worktreeChanges;
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
    const flaggedEntries = yield* run("indexFlags", sourceRoot, ["ls-files", "-v", "-z"]).pipe(
      Effect.map((result) => result.stdout.split("\0").filter((field) => field.length > 2)),
      operationFailed("Unable to read the worktree's index flags"),
    );
    const hidden: string[] = [];
    for (const field of flaggedEntries) {
      const tag = field[0]!;
      const relative = field.slice(2);
      const assumeUnchanged = tag !== tag.toUpperCase();
      if (assumeUnchanged || (tag === "S" && (yield* occupied(path.join(sourceRoot, relative))))) {
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
      yield* operationInProgress(sourceRoot).pipe(operationFailed("Unable to inspect the worktree"))
    ) {
      return yield* fail(
        "worktree_operation_in_progress",
        "The worktree is in the middle of a merge, rebase, cherry-pick, revert or bisect. Finish or abort it first.",
      );
    }
    const dirtySubmodules = yield* run("submoduleStatus", sourceRoot, [
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
    if (!input.preview && worktreeChanges.some((entry) => !isUntracked(entry))) {
      const created = yield* run("snapshot", sourceRoot, ["stash", "create"]).pipe(
        operationFailed("Unable to snapshot the worktree's changes"),
      );
      trackedSnapshot = created.stdout.trim() || null;
    }
    untrackedPaths = worktreeChanges.filter(isUntracked).map((entry) => entry.path);
  } else if (thread.branch !== null) {
    yield* refuseIfWorktreeShared(worktreeReal);
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

  if (input.preview) {
    const counts = yield* probe("aheadBehind", localPath, [
      "rev-list",
      "--left-right",
      "--count",
      `${previousLocalHead}...${branch}`,
    ]).pipe(
      Effect.map((result) => result.stdout.trim().split(/\s+/).map(Number)),
      Effect.orElseSucceed(() => [Number.NaN, Number.NaN]),
    );
    const staged = (entry: StatusEntry) => entry.code[0] !== " " && entry.code[0] !== "?";
    const unstaged = (entry: StatusEntry) => entry.code[1] !== " " && entry.code[1] !== "?";
    const files = worktreeEntries.map((entry) => ({
      path: entry.path,
      change: isUntracked(entry)
        ? ("untracked" as const)
        : staged(entry) && unstaged(entry)
          ? ("staged_and_unstaged" as const)
          : staged(entry)
            ? ("staged" as const)
            : ("unstaged" as const),
    }));
    const PREVIEW_FILES = 50;
    const countOf = (value: number | undefined) =>
      value === undefined || Number.isNaN(value) ? null : value;
    return {
      _tag: "preview",
      preview: {
        branch,
        localCheckoutPath: projectPath,
        worktreePath,
        currentLocalBranch: previousLocalBranch,
        commitsBehind: countOf(counts[0]),
        commitsAhead: countOf(counts[1]),
        changes: {
          staged: worktreeEntries.filter(staged).length,
          unstaged: worktreeEntries.filter(unstaged).length,
          untracked: worktreeEntries.filter(isUntracked).length,
        },
        files: files.slice(0, PREVIEW_FILES),
        filesOmitted: Math.max(0, files.length - PREVIEW_FILES),
        worktreeOnDisk,
        interruptedMove: false,
        blocker: null,
      },
    } satisfies MoveOutcome;
  }

  yield* writeJournal({
    version: 1,
    worktreePath,
    sourceRoot,
    branch,
    previousLocalBranch,
    previousLocalHead,
    worktreeHead: worktreeOnDisk
      ? yield* currentHead(sourceRoot).pipe(operationFailed("Unable to read the worktree's commit"))
      : null,
    snapshot: trackedSnapshot,
    untracked: untrackedPaths,
  }).pipe(operationFailed("Unable to record the move before starting it"));

  // Undo steps are registered before the command they undo, and check the real state first:
  // a failing hook can exit nonzero after git already moved HEAD.
  const rollbacks: Array<Effect.Effect<void, GitCommandError | PlatformError.PlatformError>> = [];
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
          // A clean rollback leaves nothing to recover; a partial one keeps the journal for a retry.
          if (failures.length === 0) yield* removeJournal;
          const kept =
            (keptLocalEdits.length === 0
              ? ""
              : ` These files in the local checkout differ from the worktree's copy, so they were left as they are: ${keptLocalEdits.slice(0, 5).join(", ")}.`) +
            (recoveryCommit === null
              ? ""
              : ` The checkout's tracked files before the rollback are saved as commit ${recoveryCommit}; \`git stash apply ${recoveryCommit}\` brings them back.`) +
            (recoveryDirectory === null
              ? ""
              : ` Anything the rollback took out of the checkout is under '${recoveryDirectory}'.`);
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
        if ((yield* currentBranch(sourceRoot)) !== branch) {
          yield* run("reattachWorktree", sourceRoot, [
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
      run("detachWorktree", sourceRoot, ["switch", "--detach", "--quiet"]),
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
      yield* refuseIfLocalBusy();
      // Never replace ignored local files (a .env, a build output) with the branch's copy.
      yield* run("switchLocal", localPath, ["switch", "--quiet", "--no-overwrite-ignore", branch]);
      if ((yield* currentBranch(localPath)) !== branch) {
        return yield* fail("operation_failed", `the checkout did not end up on '${branch}'`);
      }
    }),
  );

  // Untracked files this move copied into the checkout; the kept worktree still has the originals.
  const copiedFiles: string[] = [];
  const createdDirectories: string[] = [];
  rollbacks.push(
    Effect.gen(function* () {
      if (trackedSnapshot !== null) yield* undoSnapshot(trackedSnapshot);
      // Renamed aside, never deleted: whatever is there now (the copy, a partial copy, or
      // something the user wrote over it) stays recoverable.
      for (const relative of copiedFiles.toReversed()) {
        if (yield* occupied(path.join(localPath, relative))) yield* moveAside(relative);
      }
      for (const directory of createdDirectories.toReversed()) {
        yield* clearEmptyFolder(directory);
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
            const source = path.join(sourceRoot, relative);
            const target = path.join(localPath, relative);
            if ((yield* blockedAncestor(relative)) !== null) {
              return yield* fail(
                "operation_failed",
                `a symbolic link or file appeared where '${relative}' needs a folder`,
              );
            }
            yield* ensureDirectory(path.dirname(target));
            const parentReal = yield* realPath(path.dirname(target));
            if (!within(localRootReal, parentReal)) {
              return yield* fail(
                "operation_failed",
                `'${relative}' would land outside the checkout`,
              );
            }
            const link = yield* fileSystem.readLink(source).pipe(Effect.option);
            if (Option.isSome(link)) {
              // symlink() refuses an existing path, so nothing that appeared meanwhile is replaced.
              yield* fileSystem.symlink(link.value, target);
              copiedFiles.push(relative);
            } else {
              // Write through an exclusively created file: anything that appears at the path
              // meanwhile makes this fail instead of being overwritten. The mode is set at
              // creation only; a later chmod by path could follow a swapped-in symlink.
              const mode = (yield* fileSystem.stat(source)).mode & 0o777;
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const output = yield* fileSystem.open(target, { flag: "wx", mode });
                  const landed = yield* realPath(target);
                  if (!within(localRootReal, landed) || samePath(landed, localRootReal)) {
                    // Unlink the path itself: if it became a symlink, its target is not ours.
                    yield* fileSystem.remove(target, { force: true });
                    return yield* fail(
                      "operation_failed",
                      `'${relative}' would land outside the checkout`,
                    );
                  }
                  copiedFiles.push(relative);
                  yield* fileSystem
                    .stream(source)
                    .pipe(Stream.runForEach((chunk) => output.writeAll(chunk)));
                }),
              );
            }
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

  yield* removeJournal;

  for (const cwd of [localPath, sourceRoot]) {
    yield* gitWorkflow.invalidateStatus(cwd);
  }
  yield* vcsStatus
    .refreshStatus(localPath)
    .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

  const result: ThreadMoveToLocalCheckoutResult = {
    branch,
    localCheckoutPath: projectPath,
    previousWorktreePath: worktreePath,
    previousLocalBranch,
    carriedChanges: trackedSnapshot !== null || untrackedPaths.length > 0,
    previousWorktreeKept: worktreeOnDisk,
  };
  return { _tag: "moved", result } satisfies MoveOutcome;
});
