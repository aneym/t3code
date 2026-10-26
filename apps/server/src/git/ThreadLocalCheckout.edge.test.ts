import * as WorktreeMcp from "../mcp/WorktreeMcpService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  GitCommandError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ThreadLocalCheckout from "./ThreadLocalCheckout.ts";

const threadId = ThreadId.make("thread-move-to-local");
const projectId = ProjectId.make("project-move-to-local");

interface OtherThread {
  readonly id: string;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly archived?: boolean;
  readonly running?: boolean;
  readonly projectId?: string;
}

interface Fixture {
  readonly root: string;
  readonly local: string;
  readonly worktree: string;
  readonly git: (
    cwd: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, GitCommandError>;
}

const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "move-to-local-edge-git-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** A repo on `main` with `feature` checked out in a linked worktree one commit ahead. */
const makeFixture = Effect.fn("makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "move-to-local-edge-" });
  const local = `${root}/repo space ü`;
  const worktree = `${root}/worktrees/feature space ü`;
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    driver
      .execute({ operation: "move-to-local-test", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* fs.makeDirectory(local, { recursive: true });
  yield* git(local, ["init", "-b", "main"]);
  yield* git(local, ["config", "user.name", "Test"]);
  yield* git(local, ["config", "user.email", "test@example.test"]);
  yield* fs.writeFileString(`${local}/shared.txt`, "base\n");
  yield* fs.writeFileString(`${local}/.gitignore`, "ignored/\n");
  yield* git(local, ["add", "."]);
  yield* git(local, ["commit", "-m", "base"]);
  yield* git(local, ["worktree", "add", "-b", "feature", worktree]);
  yield* fs.writeFileString(`${worktree}/feature.txt`, "feature\n");
  yield* git(worktree, ["add", "feature.txt"]);
  yield* git(worktree, ["commit", "-m", "feature work"]);
  return { root, local, worktree, git } satisfies Fixture;
});

interface HarnessOptions {
  readonly fixture: Fixture;
  readonly id?: string;
  readonly project?: string;
  readonly projectRoots?: Readonly<Record<string, string>>;
  readonly threadBranch?: string | null;
  readonly threadWorktreePath?: string | null;
  readonly selfRunning?: boolean;
  readonly others?: ReadonlyArray<OtherThread>;
  readonly dispatchFails?: boolean;
  readonly dispatchGate?: Effect.Effect<void>;
}

const makeHarness = (options: HarnessOptions) => {
  const { fixture } = options;
  const movingThreadId = options.id ? ThreadId.make(options.id) : threadId;
  const movingProjectId = options.project ? ProjectId.make(options.project) : projectId;
  const thread = {
    id: movingThreadId,
    projectId: movingProjectId,
    title: "Moving thread",
    branch: options.threadBranch === undefined ? "feature" : options.threadBranch,
    worktreePath:
      options.threadWorktreePath === undefined ? fixture.worktree : options.threadWorktreePath,
    archivedAt: null,
    deletedAt: null,
  };
  const shell = (
    id: string,
    title: string,
    worktreePath: string | null,
    archived: boolean,
    running: boolean,
  ) =>
    ({
      id: ThreadId.make(id),
      projectId: movingProjectId,
      title,
      worktreePath,
      archivedAt: archived ? DateTime.makeUnsafe(0) : null,
      activeRunId: running ? "run-active" : null,
    }) as unknown as OrchestrationV2ThreadShell;
  const shells = () => [
    shell(movingThreadId, thread.title, thread.worktreePath, false, options.selfRunning ?? false),
    ...(options.others ?? []).map((other) => ({
      ...shell(
        other.id,
        other.title,
        other.worktreePath,
        other.archived ?? false,
        other.running ?? false,
      ),
      projectId: other.projectId ? ProjectId.make(other.projectId) : movingProjectId,
    })),
  ];

  const dispatch = vi.fn((command: { readonly worktreePath?: string | null }) =>
    (options.dispatchGate ?? Effect.void).pipe(
      Effect.andThen(
        options.dispatchFails
          ? Effect.fail(
              new OrchestratorDispatchError({
                commandId: "command-test" as never,
                commandType: "thread.metadata.update",
                cause: "worktree changed",
              }),
            )
          : Effect.sync(() => {
              thread.worktreePath = command.worktreePath ?? null;
              return {} as never;
            }),
      ),
    ),
  );

  const sendToThread = vi.fn(() => Effect.succeed({ delivery: "queued" } as never));
  const layer = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({ thread: { ...thread } } as unknown as OrchestrationV2ThreadProjection),
      listProjectThreads: (input) =>
        Effect.succeed(
          shells().filter((item) => item.archivedAt === null && item.projectId === input.projectId),
        ),
      getShellSnapshot: (options) =>
        Effect.succeed({
          threads:
            options?.location === "archive"
              ? []
              : shells().filter((item) => item.archivedAt === null),
          archivedThreads: shells().filter((item) => item.archivedAt !== null),
        } as never),
      dispatch: dispatch as never,
      sendToThread,
    } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
    Layer.mock(ProjectService.ProjectService)({
      getById: (requestedProjectId) =>
        Effect.succeedSome({
          id: requestedProjectId,
          title: "Project",
          workspaceRoot: options.projectRoots?.[requestedProjectId] ?? fixture.local,
          scripts: [],
        } as unknown as Project),
    } satisfies Partial<ProjectService.ProjectService["Service"]>),
    Layer.effect(GitWorkflowService.GitWorkflowService)(
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        return GitWorkflowService.GitWorkflowService.of({
          isRepository: () => Effect.succeed(true),
          removeWorktree: (input: {
            readonly cwd: string;
            readonly path: string;
            readonly force?: boolean;
          }) =>
            driver
              .execute({
                operation: "test.removeWorktree",
                cwd: input.cwd,
                args: ["worktree", "remove", ...(input.force ? ["--force"] : []), input.path],
              })
              .pipe(Effect.asVoid),
          invalidateStatus: () => Effect.void,
        } as unknown as GitWorkflowService.GitWorkflowService["Service"]);
      }),
    ),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus: () => Effect.void as never,
    } satisfies Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>),
  );

  const move = (input: Partial<ThreadLocalCheckout.MoveThreadToLocalCheckoutInput> = {}) =>
    ThreadLocalCheckout.moveThreadToLocalCheckout({ threadId: movingThreadId, ...input }).pipe(
      Effect.provide(layer),
    );

  return { thread, dispatch, move, layer, sendToThread };
};

const expectCode = (exit: Exit.Exit<unknown, unknown>, code: string) => {
  if (!Exit.isFailure(exit)) expect.fail(`Expected failure ${code}, got success`);
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") expect.fail(`Expected a typed failure, got ${reason?._tag}`);
  expect(reason.error).toMatchObject({ _tag: "ThreadMoveToLocalCheckoutError", code });
};

const currentBranch = (fixture: Fixture, cwd: string) =>
  fixture.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

const stashCount = (fixture: Fixture) =>
  fixture
    .git(fixture.local, ["stash", "list"])
    .pipe(Effect.map((out) => (out.length === 0 ? 0 : out.split("\n").length)));

/** Asserts nothing moved: the worktree still owns `feature` and the checkout stayed on `main`. */
const expectUntouched = Effect.fn("expectUntouched")(function* (fixture: Fixture) {
  expect(yield* currentBranch(fixture, fixture.worktree)).toBe("feature");
  expect(yield* currentBranch(fixture, fixture.local)).toBe("main");
  expect(yield* stashCount(fixture)).toBe(0);
});

const state = Effect.fn(function* (f: Fixture) {
  return {
    localBranch: yield* currentBranch(f, f.local),
    localStatus: yield* f.git(f.local, ["status", "--porcelain=v1", "--untracked-files=all"]),
    worktreeBranch: yield* currentBranch(f, f.worktree),
    worktreeStatus: yield* f.git(f.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]),
    stash: yield* f.git(f.local, ["stash", "list", "--format=%H %s"]),
  };
});
const instrument = Effect.fn(function* (
  intercept: (
    input: GitVcsDriver.ExecuteGitInput,
    execute: GitVcsDriver.GitVcsDriver["Service"]["execute"],
  ) => ReturnType<GitVcsDriver.GitVcsDriver["Service"]["execute"]>,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  return {
    ...driver,
    execute: (input: GitVcsDriver.ExecuteGitInput) =>
      Effect.suspend(() => intercept(input, driver.execute)),
  };
});
const isSymlink = (target: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readLink(target)),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
const installHook = Effect.fn(function* (f: Fixture, script: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* f.git(f.local, ["rev-parse", "--absolute-git-dir"]);
  yield* fs.writeFileString(`${dir}/hooks/post-checkout`, `#!/bin/sh\n${script}\n`);
  yield* fs.chmod(`${dir}/hooks/post-checkout`, 0o755);
});

describe("data safety", () => {
  it.effect("refuses a detached worktree even when the checkout is on its branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* f.git(f.worktree, ["switch", "--detach", "HEAD~1"]);
      yield* fs.writeFileString(`${f.worktree}/detached.txt`, "only detached commit\n");
      yield* f.git(f.worktree, ["add", "."]);
      yield* f.git(f.worktree, ["commit", "-m", "detached work"]);
      const detachedHead = yield* f.git(f.worktree, ["rev-parse", "HEAD"]);
      yield* f.git(f.local, ["switch", "feature"]);
      const h = makeHarness({ fixture: f });
      expectCode(yield* Effect.exit(h.move()), "worktree_detached");
      expect(yield* f.git(f.worktree, ["rev-parse", "HEAD"])).toBe(detachedHead);
      expect(h.dispatch).not.toHaveBeenCalled();
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("preserves local ignored files that the target branch tracks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const dir = yield* f.git(f.local, ["rev-parse", "--absolute-git-dir"]);
      yield* fs.writeFileString(`${dir}/info/exclude`, "feature.txt\n");
      yield* fs.writeFileString(`${f.local}/feature.txt`, "user secret, not in git\n");
      expectCode(yield* Effect.exit(makeHarness({ fixture: f }).move()), "untracked_collision");
      expect(yield* fs.readFileString(`${f.local}/feature.txt`)).toBe("user secret, not in git\n");
      expect(yield* currentBranch(f, f.worktree)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("rollback preserves a pre-existing dangling local symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/notes.txt`, "moving notes\n");
      yield* fs.symlink("missing-target", `${f.local}/notes.txt`);
      expect(yield* isSymlink(`${f.local}/notes.txt`)).toBe(true);
      expectCode(yield* Effect.exit(makeHarness({ fixture: f }).move()), "untracked_collision");
      expect(yield* isSymlink(`${f.local}/notes.txt`)).toBe(true);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("failing detach post-checkout hook restores the worktree branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "staged\n");
      yield* f.git(f.worktree, ["add", "shared.txt"]);
      const before = yield* state(f);
      yield* installHook(f, "exit 1");
      const exit = yield* Effect.exit(makeHarness({ fixture: f }).move());
      const after = yield* state(f);
      expectCode(exit, "operation_failed");
      expect(after).toEqual(before);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("failing local post-checkout hook restores both branches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "moving edits\n");
      const before = yield* state(f);
      yield* installHook(f, 'case "$PWD" in */"repo space ü") exit 1;; esac\nexit 0');
      const exit = yield* Effect.exit(makeHarness({ fixture: f }).move());
      const after = yield* state(f);
      expectCode(exit, "operation_failed");
      expect(after).toEqual(before);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("sharer lookup recognizes a trailing-slash alias", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const h = makeHarness({
        fixture: f,
        others: [{ id: "other", title: "Still using it", worktreePath: `${f.worktree}/` }],
      });
      const exit = yield* Effect.exit(h.move());
      expectCode(exit, "worktree_shared");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("checkout guard recognizes a symlinked project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const alias = `${f.root}/alias`;
      yield* fs.symlink(f.local, alias);
      yield* f.git(f.local, ["worktree", "add", "-b", "second", `${f.root}/second`]);
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const first = makeHarness({
        fixture: f,
        dispatchGate: Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
      });
      const second = makeHarness({
        id: "second-thread",
        project: "alias-project",
        fixture: { ...f, local: alias, worktree: `${f.root}/second` },
        threadBranch: "second",
      });
      const fiber = yield* Effect.forkChild(first.move());
      yield* Deferred.await(reached);
      const secondExit = yield* Effect.exit(second.move());
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(fiber)).branch).toBe("feature");
      expectCode(secondExit, "move_in_progress");
      expect(yield* currentBranch(f, f.local)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("refuses dirty submodule content before moving", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const source = `${f.root}/module-source`;
      yield* fs.makeDirectory(source);
      yield* f.git(source, ["init", "-b", "main"]);
      yield* f.git(source, ["config", "user.name", "Test"]);
      yield* f.git(source, ["config", "user.email", "test@example.test"]);
      yield* fs.writeFileString(`${source}/module.txt`, "base module\n");
      yield* f.git(source, ["add", "."]);
      yield* f.git(source, ["commit", "-m", "module"]);
      yield* f.git(f.worktree, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        source,
        "module",
      ]);
      yield* f.git(f.worktree, ["commit", "-am", "add module"]);
      yield* fs.writeFileString(`${f.worktree}/module/module.txt`, "uncommitted module work\n");
      const exit = yield* Effect.exit(makeHarness({ fixture: f }).move());
      const localContent = yield* fs
        .readFileString(`${f.local}/module/module.txt`)
        .pipe(Effect.orElseSucceed(() => "MISSING"));
      expect(Exit.isFailure(exit) || localContent === "uncommitted module work\n").toBe(true);
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("repository shapes", () => {
  it.effect.each(["topic/slash", "分支/é", "feature.txt", "origin/main"])(
    "uses real worktree branch %s rather than stale metadata",
    (branch) =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        yield* f.git(f.worktree, ["branch", "-m", branch]);
        expect((yield* makeHarness({ fixture: f, threadBranch: "stale-name" }).move()).branch).toBe(
          branch,
        );
        expect(yield* currentBranch(f, f.local)).toBe(branch);
      }).pipe(Effect.provide(gitLayer)),
  );
  it.effect(
    "preserves renames deletions binary executable symlink and file-directory changes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Override the test setup env, which otherwise forces core.filemode=false.
        const driver = yield* instrument((input, execute) =>
          execute({ ...input, args: ["-c", "core.filemode=true", ...input.args] }),
        );
        const f = yield* makeFixture().pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
        );
        yield* f.git(f.worktree, ["mv", "shared.txt", "renamed.txt"]);
        yield* f.git(f.worktree, ["rm", "feature.txt"]);
        yield* fs.makeDirectory(`${f.worktree}/feature.txt`);
        yield* fs.writeFileString(`${f.worktree}/feature.txt/child`, "directory now\n");
        yield* fs.writeFile(`${f.worktree}/binary`, new Uint8Array([0, 255, 0, 13, 10, 42]));
        yield* fs.writeFileString(`${f.worktree}/executable`, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(`${f.worktree}/executable`, 0o755);
        yield* fs.symlink("renamed.txt", `${f.worktree}/link`);
        yield* f.git(f.worktree, ["add", "."]);
        yield* fs.writeFileString(`${f.worktree}/renamed.txt`, "unstaged after rename\n");
        const before = yield* f.git(f.worktree, ["diff", "--binary", "HEAD"]);
        const index = yield* f.git(f.worktree, ["diff", "--cached", "--binary"]);
        yield* makeHarness({ fixture: f })
          .move()
          .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
        expect(yield* f.git(f.local, ["diff", "--binary", "HEAD"])).toBe(before);
        expect(yield* f.git(f.local, ["diff", "--cached", "--binary"])).toBe(index);
        expect(yield* isSymlink(`${f.local}/link`)).toBe(true);
        expect((yield* fs.stat(`${f.local}/executable`)).mode & 0o111).toBe(0o111);
      }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("status.showUntrackedFiles=no does not hide collision checks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* f.git(f.local, ["config", "status.showUntrackedFiles", "no"]);
      yield* fs.writeFileString(`${f.local}/notes`, "local\n");
      yield* fs.writeFileString(`${f.worktree}/notes`, "worktree\n");
      expectCode(yield* Effect.exit(makeHarness({ fixture: f }).move()), "untracked_collision");
      yield* expectUntouched(f);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect.each(["trailing", "relative", "symlink"])("accepts a %s worktree path", (variant) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const alias = `${f.root}/linked-worktree`;
      if (variant === "symlink") yield* fs.symlink(f.worktree, alias);
      const worktreePath =
        variant === "relative"
          ? (yield* Path.Path).relative(process.cwd(), f.worktree)
          : variant === "trailing"
            ? `${f.worktree}/`
            : alias;
      const result = yield* makeHarness({ fixture: f, threadWorktreePath: worktreePath }).move();
      expect(result.branch).toBe("feature");
      expect(yield* currentBranch(f, f.local)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("failed metadata dispatch restores complex staged and untracked state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* f.git(f.worktree, ["mv", "shared.txt", "renamed.txt"]);
      yield* fs.writeFileString(`${f.worktree}/renamed.txt`, "unstaged\n");
      yield* fs.makeDirectory(`${f.worktree}/newdir/nested`, { recursive: true });
      yield* fs.writeFileString(`${f.worktree}/newdir/nested/untracked`, "moving file\n");
      yield* fs.makeDirectory(`${f.local}/newdir/nested`, { recursive: true });
      yield* fs.writeFileString(`${f.local}/newdir/nested/local`, "local file\n");
      const before = yield* state(f);
      const index = yield* f.git(f.worktree, ["diff", "--cached", "--binary"]);
      expectCode(
        yield* Effect.exit(makeHarness({ fixture: f, dispatchFails: true }).move()),
        "operation_failed",
      );
      expect(yield* state(f)).toEqual(before);
      expect(yield* f.git(f.worktree, ["diff", "--cached", "--binary"])).toBe(index);
      expect(yield* fs.readFileString(`${f.local}/newdir/nested/local`)).toBe("local file\n");
      expect(yield* fs.exists(`${f.local}/newdir/nested/untracked`)).toBe(false);
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("stash safety", () => {
  it.effect("never writes refs/stash, even while the user stashes during the move", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "moving edits\n");
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "moving new file\n");
      yield* f.git(f.local, ["worktree", "add", "-b", "user", `${f.root}/user`]);
      const driver = yield* instrument((input, execute) =>
        execute(input).pipe(
          Effect.tap(() =>
            input.operation === "ThreadLocalCheckout.switchLocal"
              ? Effect.gen(function* () {
                  yield* fs.writeFileString(`${f.root}/user/personal.txt`, "only in user stash\n");
                  yield* f.git(`${f.root}/user`, [
                    "stash",
                    "push",
                    "--include-untracked",
                    "-m",
                    "user during move",
                  ]);
                }).pipe(Effect.orDie)
              : Effect.void,
          ),
        ),
      );
      const result = yield* makeHarness({ fixture: f })
        .move()
        .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      expect(result.carriedChanges).toBe(true);
      expect(yield* f.git(f.local, ["stash", "list", "--format=%s"])).toBe(
        "On user: user during move",
      );
      expect(yield* fs.readFileString(`${f.local}/shared.txt`)).toBe("moving edits\n");
      expect(yield* fs.readFileString(`${f.local}/new.txt`)).toBe("moving new file\n");
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("more repository states", () => {
  it.effect("refuses local unborn HEAD without touching the source", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.git(f.local, ["switch", "--orphan", "unborn"]);
      const before = yield* f.git(f.worktree, ["rev-parse", "HEAD"]);
      const exit = yield* Effect.exit(makeHarness({ fixture: f }).move());
      expectCode(exit, "operation_failed");
      expect(yield* f.git(f.local, ["symbolic-ref", "--short", "HEAD"])).toBe("unborn");
      expect(yield* f.git(f.worktree, ["rev-parse", "HEAD"])).toBe(before);
      expect(yield* stashCount(f)).toBe(0);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("refuses a paused nonconflicted rebase without touching it", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* Effect.exit(f.git(f.worktree, ["rebase", "--exec", "false", "main"]));
      const before = yield* state(f);
      const exit = yield* Effect.exit(makeHarness({ fixture: f }).move());
      expectCode(exit, "worktree_detached");
      expect(yield* state(f)).toEqual(before);
      yield* f.git(f.worktree, ["rebase", "--abort"]);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("carries CRLF and a git-lfs-style clean smudge filter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Override the test setup env, which otherwise forces core.autocrlf=false.
      const driver = yield* instrument((input, execute) =>
        execute({ ...input, args: ["-c", "core.autocrlf=true", ...input.args] }),
      );
      const f = yield* makeFixture().pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* f.git(f.local, ["config", "core.autocrlf", "true"]);
      yield* f.git(f.local, ["config", "filter.fake-lfs.clean", "cat"]);
      yield* f.git(f.local, ["config", "filter.fake-lfs.smudge", "cat"]);
      yield* f.git(f.local, ["config", "filter.fake-lfs.required", "true"]);
      yield* fs.writeFileString(`${f.worktree}/.gitattributes`, "*.bin filter=fake-lfs -text\n");
      yield* fs.writeFileString(`${f.worktree}/crlf.txt`, "line one\r\nline two\r\n");
      yield* fs.writeFile(`${f.worktree}/blob.bin`, new Uint8Array([0, 255, 5]));
      yield* f.git(f.worktree, ["add", "."]);
      const before = yield* f.git(f.worktree, ["diff", "--cached", "--binary"]);
      yield* makeHarness({ fixture: f })
        .move()
        .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      expect(yield* f.git(f.local, ["diff", "--cached", "--binary"])).toBe(before);
      expect(yield* fs.readFileString(`${f.local}/crlf.txt`)).toBe("line one\r\nline two\r\n");
      expect(Array.from(yield* fs.readFile(`${f.local}/blob.bin`))).toEqual([0, 255, 5]);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("carries changes from sparse checkout into the full local checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.makeDirectory(`${f.worktree}/included`);
      yield* fs.makeDirectory(`${f.worktree}/excluded`);
      yield* fs.writeFileString(`${f.worktree}/included/a`, "included\n");
      yield* fs.writeFileString(`${f.worktree}/excluded/b`, "excluded\n");
      yield* f.git(f.worktree, ["add", "."]);
      yield* f.git(f.worktree, ["commit", "-m", "sparse folders"]);
      yield* f.git(f.worktree, ["sparse-checkout", "set", "included"]);
      yield* fs.writeFileString(`${f.worktree}/included/a`, "dirty sparse\n");
      yield* makeHarness({ fixture: f }).move();
      expect(yield* fs.readFileString(`${f.local}/included/a`)).toBe("dirty sparse\n");
      expect(yield* fs.readFileString(`${f.local}/excluded/b`)).toBe("excluded\n");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("same-thread moves remain serialized even through a path alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const first = makeHarness({
        fixture: f,
        dispatchGate: Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
      });
      const alias = `${f.root}/alias`;
      yield* fs.symlink(f.local, alias);
      const second = makeHarness({ fixture: { ...f, local: alias } });
      const fiber = yield* Effect.forkChild(first.move());
      yield* Deferred.await(reached);
      const exit = yield* Effect.exit(second.move());
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(fiber);
      expectCode(exit, "move_in_progress");
    }).pipe(Effect.provide(gitLayer)),
  );
});

const mcpLayer = (harness: ReturnType<typeof makeHarness>) =>
  WorktreeMcp.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        ServerSettings.layerTest({}),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
      ),
    ),
  );

describe("MCP move", () => {
  it.effect.each([false, true])("checks worktree capability, granted=%s", (granted) =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const h = makeHarness({ fixture: f, selfRunning: true });
      const scope = {
        capabilities: new Set(granted ? ["worktree"] : []),
        environmentId: EnvironmentId.make("test-env"),
        issuedAt: 1,
        requestNamespace: "test-move",
        thread: {
          threadId,
          providerSessionId: "test-session",
          providerInstanceId: ProviderInstanceId.make("test-provider"),
        },
        client: undefined,
      } as McpInvocationScope;
      const exit = yield* WorktreeMcp.WorktreeMcpService.pipe(
        Effect.flatMap((service) => service.moveToLocal(scope, {})),
        Effect.provide(mcpLayer(h)),
        Effect.exit,
      );
      if (granted) {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(h.thread.worktreePath).toBe(null);
        expect(yield* currentBranch(f, f.local)).toBe("feature");
      } else {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(exit.cause.reasons[0]).toMatchObject({
            _tag: "Fail",
            error: { code: "capability_denied" },
          });
        expect(h.dispatch).not.toHaveBeenCalled();
        yield* expectUntouched(f);
      }
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("boundaries", () => {
  it.effect("long paths and branch names keep their exact values", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const fs = yield* FileSystem.FileSystem;
      const parent = `${f.root}/${"long directory ü ".repeat(10)}`;
      yield* fs.makeDirectory(parent);
      const target = `${parent}/${"worktree ä ".repeat(10)}`;
      yield* f.git(f.local, ["worktree", "move", f.worktree, target]);
      const branch = `topic/${"longbranch".repeat(15)}`;
      yield* f.git(target, ["branch", "-m", branch]);
      const result = yield* makeHarness({
        fixture: { ...f, worktree: target },
        threadBranch: branch,
      }).move();
      expect(result.branch).toBe(branch);
      expect(result.previousWorktreePath).toBe(target);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("empty pre-existing directories survive metadata rollback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.makeDirectory(`${f.local}/empty/nested`, { recursive: true });
      yield* fs.makeDirectory(`${f.worktree}/empty/nested`, { recursive: true });
      yield* fs.writeFileString(`${f.worktree}/empty/nested/notes`, "moving notes\n");
      expectCode(
        yield* Effect.exit(makeHarness({ fixture: f, dispatchFails: true }).move()),
        "operation_failed",
      );
      expect(yield* fs.exists(`${f.local}/empty/nested`)).toBe(true);
      expect(yield* fs.exists(`${f.local}/empty/nested/notes`)).toBe(false);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("refuses a mid-merge checkout even when the worktree is detached", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* f.git(f.worktree, ["switch", "--detach"]);
      yield* f.git(f.local, ["switch", "feature"]);
      const gitDir = yield* f.git(f.local, ["rev-parse", "--absolute-git-dir"]);
      yield* fs.writeFileString(
        `${gitDir}/MERGE_HEAD`,
        `${yield* f.git(f.local, ["rev-parse", "HEAD"])}\n`,
      );
      const exit = yield* Effect.exit(makeHarness({ fixture: f }).move());
      expectCode(exit, "local_operation_in_progress");
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("injected step failures", () => {
  it.effect.each(["snapshot", "detachWorktree", "switchLocal", "applySnapshot"])(
    "restores all state when %s fails",
    (operation) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeFixture();
        yield* fs.writeFileString(`${f.local}/shared.txt`, "pre-existing stash\n");
        yield* f.git(f.local, ["stash", "push", "-m", "user stash"]);
        yield* fs.writeFileString(`${f.local}/local-notes`, "existing local untracked\n");
        yield* fs.writeFileString(`${f.worktree}/shared.txt`, "staged source\n");
        yield* f.git(f.worktree, ["add", "shared.txt"]);
        yield* fs.writeFileString(`${f.worktree}/shared.txt`, "unstaged source\n");
        yield* fs.makeDirectory(`${f.worktree}/untracked`);
        yield* fs.writeFileString(`${f.worktree}/untracked/notes`, "source untracked\n");
        const before = yield* state(f);
        const indexBefore = yield* f.git(f.worktree, ["diff", "--cached", "--binary"]);
        const driver = yield* instrument((input, execute) =>
          input.operation === `ThreadLocalCheckout.${operation}`
            ? Effect.fail(
                new GitCommandError({
                  operation: input.operation,
                  cwd: input.cwd,
                  command: "git",
                  argumentCount: input.args.length,
                  detail: `injected ${operation} failure`,
                }),
              )
            : execute(input),
        );
        expectCode(
          yield* Effect.exit(
            makeHarness({ fixture: f })
              .move()
              .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver)),
          ),
          "operation_failed",
        );
        expect(yield* state(f)).toEqual(before);
        expect(yield* f.git(f.worktree, ["diff", "--cached", "--binary"])).toBe(indexBefore);
        expect(yield* fs.readFileString(`${f.worktree}/shared.txt`)).toBe("unstaged source\n");
        expect(yield* fs.readFileString(`${f.worktree}/untracked/notes`)).toBe(
          "source untracked\n",
        );
        expect(yield* fs.readFileString(`${f.local}/local-notes`)).toBe(
          "existing local untracked\n",
        );
      }).pipe(Effect.provide(gitLayer)),
  );
});

describe("MCP continuation interruption", () => {
  it.effect("queues the continuation when workspace detachment interrupts the caller", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const h = makeHarness({
        fixture: f,
        selfRunning: true,
        dispatchGate: Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
      });
      const scope = {
        capabilities: new Set(["worktree"]),
        environmentId: EnvironmentId.make("test-env"),
        issuedAt: 1,
        requestNamespace: "test-move",
        client: undefined,
        thread: {
          threadId,
          providerSessionId: "test-session",
          providerInstanceId: ProviderInstanceId.make("test-provider"),
        },
      } as McpInvocationScope;
      const move = WorktreeMcp.WorktreeMcpService.pipe(
        Effect.flatMap((service) =>
          service.moveToLocal(scope, { continuationPrompt: "resume work" }),
        ),
        Effect.provide(mcpLayer(h)),
      );
      const fiber = yield* Effect.forkChild(move);
      yield* Deferred.await(reached);
      // The workspace event can terminate the provider tool request while the inner move is masked.
      fiber.interruptUnsafe();
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.await(fiber);
      expect(h.thread.worktreePath).toBe(null);
      expect(h.sendToThread).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("writers racing the move", () => {
  it.effect("a write to the worktree during the move stays in the kept worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "snapshot version\n");
      const h = makeHarness({
        fixture: f,
        selfRunning: true,
        // An agent's background process writing after the snapshot was taken.
        dispatchGate: Effect.gen(function* () {
          yield* fs.writeFileString(`${f.worktree}/shared.txt`, "newer background edit\n");
          yield* fs.writeFileString(`${f.worktree}/late.txt`, "new background file\n");
        }).pipe(Effect.orDie),
      });
      const result = yield* h.move({ allowActiveRun: true });
      expect(result.previousWorktreeKept).toBe(true);
      expect(yield* fs.readFileString(`${f.local}/shared.txt`)).toBe("snapshot version\n");
      expect(yield* fs.readFileString(`${f.worktree}/shared.txt`)).toBe("newer background edit\n");
      expect(yield* fs.readFileString(`${f.worktree}/late.txt`)).toBe("new background file\n");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("rollback leaves an edit made in the checkout during the move", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "moving edit\n");
      const driver = yield* instrument((input, execute) =>
        input.operation === "ThreadLocalCheckout.applySnapshot"
          ? fs
              .writeFileString(`${f.local}/shared.txt`, "user typed this during move\n")
              .pipe(Effect.orDie, Effect.andThen(execute(input)))
          : execute(input),
      );
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f })
          .move()
          .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver)),
      );
      expectCode(exit, "operation_failed");
      expect(yield* fs.readFileString(`${f.local}/shared.txt`)).toBe(
        "user typed this during move\n",
      );
      expect(yield* fs.readFileString(`${f.worktree}/shared.txt`)).toBe("moving edit\n");
      expect(yield* currentBranch(f, f.worktree)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("never overwrites a file that appears in the checkout while copying", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "incoming new file\n");
      const racingFs = {
        ...fs,
        open: ((target: string, options?: Parameters<typeof fs.open>[1]) =>
          (target === `${f.local}/new.txt`
            ? fs.writeFileString(target, "user created this during copy\n")
            : Effect.void
          ).pipe(Effect.andThen(fs.open(target, options)))) as typeof fs.open,
      };
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f })
          .move()
          .pipe(Effect.provideService(FileSystem.FileSystem, racingFs)),
      );
      expectCode(exit, "operation_failed");
      expect(yield* fs.readFileString(`${f.local}/new.txt`)).toBe(
        "user created this during copy\n",
      );
      expect(yield* fs.readFileString(`${f.worktree}/new.txt`)).toBe("incoming new file\n");
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("index flags and destination folders", () => {
  it.effect.each(["--assume-unchanged", "--skip-worktree"])("refuses edits hidden by %s", (flag) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* f.git(f.worktree, ["update-index", flag, "shared.txt"]);
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "hidden user work\n");
      expectCode(yield* Effect.exit(makeHarness({ fixture: f }).move()), "hidden_changes");
      yield* expectUntouched(f);
      expect(yield* fs.readFileString(`${f.worktree}/shared.txt`)).toBe("hidden user work\n");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("refuses a destination folder that is a symlink out of the checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const external = `${f.root}/external`;
      yield* fs.makeDirectory(external);
      yield* fs.symlink(external, `${f.local}/notes`);
      yield* fs.makeDirectory(`${f.worktree}/notes`);
      yield* fs.writeFileString(`${f.worktree}/notes/new.txt`, "source note\n");
      expectCode(yield* Effect.exit(makeHarness({ fixture: f }).move()), "untracked_collision");
      yield* expectUntouched(f);
      expect(yield* fs.exists(`${external}/new.txt`)).toBe(false);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("keeps an untracked file's permission bits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/script`, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(`${f.worktree}/script`, 0o751);
      yield* makeHarness({ fixture: f }).move();
      expect((yield* fs.stat(`${f.local}/script`)).mode & 0o777).toBe(0o751);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("refuses a nested repository without touching its contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const nested = `${f.worktree}/nested`;
      yield* fs.makeDirectory(nested);
      yield* f.git(nested, ["init", "-b", "main"]);
      yield* fs.writeFileString(`${nested}/only-copy`, "nested user work\n");
      expectCode(yield* Effect.exit(makeHarness({ fixture: f }).move()), "operation_failed");
      yield* expectUntouched(f);
      expect(yield* fs.readFileString(`${nested}/only-copy`)).toBe("nested user work\n");
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("rollback keeps what it did not write", () => {
  it.effect("keeps a user's edit to a copied untracked file in the recovery folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/notes.txt`, "source notes\n");
      const exit = yield* Effect.exit(
        makeHarness({
          fixture: f,
          dispatchFails: true,
          dispatchGate: fs
            .writeFileString(`${f.local}/notes.txt`, "user's unique edit\n")
            .pipe(Effect.orDie),
        }).move(),
      );
      expectCode(exit, "operation_failed");
      const recovery = /is under '([^']+)'/.exec(JSON.stringify(exit))?.[1];
      expect(recovery).toBeDefined();
      expect(yield* fs.readFileString(`${recovery}/files/notes.txt`)).toBe("user's unique edit\n");
      expect(yield* fs.readFileString(`${f.worktree}/notes.txt`)).toBe("source notes\n");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("leaves a user's executable-bit edit to a carried file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "carried edit\n");
      const exit = yield* Effect.exit(
        makeHarness({
          fixture: f,
          dispatchFails: true,
          dispatchGate: fs.chmod(`${f.local}/shared.txt`, 0o755).pipe(Effect.orDie),
        }).move(),
      );
      expectCode(exit, "operation_failed");
      expect((yield* fs.stat(`${f.local}/shared.txt`)).mode & 0o777).toBe(0o755);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("moves a partially copied file aside after a write failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const size = 4 * 1024 * 1024;
      yield* fs.writeFile(`${f.worktree}/large.bin`, new Uint8Array(size).fill(65));
      const failingFs = {
        ...fs,
        open: ((target: string, options?: Parameters<typeof fs.open>[1]) =>
          fs.open(target, options).pipe(
            Effect.map((output) =>
              target !== `${f.local}/large.bin`
                ? output
                : {
                    ...output,
                    writeAll: (chunk: Uint8Array) =>
                      output
                        .writeAll(chunk.subarray(0, 7))
                        .pipe(Effect.andThen(Effect.die(new Error("injected write failure")))),
                  },
            ),
          )) as typeof fs.open,
      };
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f })
          .move()
          .pipe(Effect.provideService(FileSystem.FileSystem, failingFs)),
      );
      expectCode(exit, "operation_failed");
      expect(yield* fs.exists(`${f.local}/large.bin`)).toBe(false);
      expect(JSON.stringify(exit)).toContain("t3-move-to-local");
      expect((yield* fs.stat(`${f.worktree}/large.bin`)).size).toBe(BigInt(size));
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("restores a CRLF checkout cleanly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* f.git(f.local, ["config", "core.autocrlf", "true"]);
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "carried CRLF\r\n");
      expectCode(
        yield* Effect.exit(makeHarness({ fixture: f, dispatchFails: true }).move()),
        "operation_failed",
      );
      expect(yield* f.git(f.local, ["status", "--porcelain=v1"])).toBe("");
      expect(yield* currentBranch(f, f.local)).toBe("main");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect.each(["file-to-directory", "directory-to-file"])(
    "leaves the checkout clean after a %s change is refused or rolled back",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeFixture();
        if (kind === "file-to-directory") {
          yield* fs.remove(`${f.worktree}/shared.txt`);
          yield* fs.makeDirectory(`${f.worktree}/shared.txt`);
          yield* fs.writeFileString(`${f.worktree}/shared.txt/nested`, "nested\n");
        } else {
          yield* fs.makeDirectory(`${f.worktree}/folder`);
          yield* fs.writeFileString(`${f.worktree}/folder/nested`, "nested\n");
          yield* f.git(f.worktree, ["add", "."]);
          yield* f.git(f.worktree, ["commit", "-m", "base folder"]);
          yield* fs.remove(`${f.worktree}/folder`, { recursive: true });
          yield* fs.writeFileString(`${f.worktree}/folder`, "replacement\n");
        }
        yield* f.git(f.worktree, ["add", "-A"]);
        expectCode(
          yield* Effect.exit(makeHarness({ fixture: f, dispatchFails: true }).move()),
          kind === "file-to-directory" ? "untracked_collision" : "operation_failed",
        );
        expect(yield* f.git(f.local, ["status", "--porcelain=v1"])).toBe("");
        expect(yield* currentBranch(f, f.local)).toBe("main");
      }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("treats wildcard filenames literally", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/a*.txt`, "original star\n");
      yield* fs.writeFileString(`${f.worktree}/ab.txt`, "original ab\n");
      yield* f.git(f.worktree, ["add", "."]);
      yield* f.git(f.worktree, ["commit", "-m", "wildcard baseline"]);
      yield* fs.writeFileString(`${f.worktree}/a*.txt`, "carried star\n");
      yield* Effect.exit(
        makeHarness({
          fixture: f,
          dispatchFails: true,
          dispatchGate: fs
            .writeFileString(`${f.local}/ab.txt`, "unique user edit\n")
            .pipe(Effect.orDie),
        }).move(),
      );
      expect(yield* fs.readFileString(`${f.local}/ab.txt`)).toBe("unique user edit\n");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("does not let the branch restore overwrite an ignored file a hook created", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* f.git(f.worktree, ["rm", "shared.txt"]);
      yield* f.git(f.worktree, ["commit", "-m", "branch removes shared"]);
      const dir = yield* f.git(f.local, ["rev-parse", "--absolute-git-dir"]);
      yield* fs.writeFileString(`${dir}/info/exclude`, "shared.txt\n");
      yield* installHook(
        f,
        'case "$PWD" in */"repo space ü")\nif [ "$(git symbolic-ref --short HEAD)" = feature ]; then\nprintf "user hook edit\\n" > shared.txt\nexit 1\nfi\n;; esac\nexit 0',
      );
      expectCode(yield* Effect.exit(makeHarness({ fixture: f }).move()), "operation_failed");
      expect(yield* fs.readFileString(`${f.local}/shared.txt`)).toBe("user hook edit\n");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("refuses to copy through a folder swapped for a symlink mid-move", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const outside = `${f.root}/outside`;
      yield* fs.makeDirectory(outside);
      yield* fs.makeDirectory(`${f.worktree}/sub`);
      yield* fs.writeFileString(`${f.worktree}/sub/new.txt`, "copied outside\n");
      const racingFs = {
        ...fs,
        open: ((target: string, options?: Parameters<typeof fs.open>[1]) =>
          (target === `${f.local}/sub/new.txt`
            ? fs
                .remove(`${f.local}/sub`, { recursive: true })
                .pipe(Effect.andThen(fs.symlink(outside, `${f.local}/sub`)))
            : Effect.void
          ).pipe(Effect.andThen(fs.open(target, options)))) as typeof fs.open,
      };
      expectCode(
        yield* Effect.exit(
          makeHarness({ fixture: f })
            .move()
            .pipe(Effect.provideService(FileSystem.FileSystem, racingFs)),
        ),
        "operation_failed",
      );
      expect(yield* fs.exists(`${outside}/new.txt`)).toBe(false);
      expect(yield* fs.readFileString(`${f.worktree}/sub/new.txt`)).toBe("copied outside\n");
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("the kept worktree", () => {
  it.effect("still holds edits hidden by index flags set mid-move", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const result = yield* makeHarness({
        fixture: f,
        dispatchGate: Effect.gen(function* () {
          yield* f.git(f.worktree, ["update-index", "--assume-unchanged", "shared.txt"]);
          yield* fs.writeFileString(`${f.worktree}/shared.txt`, "hidden unique edit\n");
        }).pipe(Effect.orDie),
      }).move();
      expect(result.previousWorktreeKept).toBe(true);
      expect(yield* fs.readFileString(`${f.worktree}/shared.txt`)).toBe("hidden unique edit\n");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("still holds an index-only change made mid-move", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* makeHarness({
        fixture: f,
        dispatchGate: Effect.gen(function* () {
          yield* fs.writeFileString(`${f.worktree}/shared.txt`, "index-only content\n");
          yield* f.git(f.worktree, ["add", "shared.txt"]);
          yield* fs.writeFileString(`${f.worktree}/shared.txt`, "base\n");
        }).pipe(Effect.orDie),
      }).move();
      expect(yield* f.git(f.worktree, ["show", ":shared.txt"])).toBe("index-only content");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("carries an untracked filename containing a newline", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const name = "two\nlines.txt";
      yield* fs.writeFileString(`${f.worktree}/${name}`, "new file\n");
      const result = yield* makeHarness({ fixture: f }).move();
      expect(result.carriedChanges).toBe(true);
      expect(yield* fs.readFileString(`${f.local}/${name}`)).toBe("new file\n");
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("project roots and late arrivals", () => {
  it.effect("copies to the repository root for a project rooted in a subfolder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const projectRoot = `${f.local}/packages/app`;
      yield* fs.makeDirectory(projectRoot, { recursive: true });
      yield* fs.writeFileString(`${f.worktree}/notes.txt`, "source notes\n");
      const result = yield* makeHarness({ fixture: { ...f, local: projectRoot } }).move();
      expect(result.localCheckoutPath).toBe(projectRoot);
      expect(yield* fs.readFileString(`${f.local}/notes.txt`)).toBe("source notes\n");
      expect(yield* fs.exists(`${projectRoot}/notes.txt`)).toBe(false);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("refuses a local thread that starts after the first busy check", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const others: OtherThread[] = [];
      const h = makeHarness({ fixture: f, others });
      const driver = yield* instrument((input, execute) => {
        if (input.operation === "ThreadLocalCheckout.detachWorktree") {
          others.push({
            id: "started-during-move",
            title: "Running local thread",
            worktreePath: null,
            running: true,
          });
        }
        return execute(input);
      });
      const exit = yield* Effect.exit(
        h.move().pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver)),
      );
      expectCode(exit, "operation_failed");
      expect(JSON.stringify(exit)).toContain("Running local thread");
      yield* expectUntouched(f);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("keeps an edit that lands on a tracked file while the rollback restores it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "carried edit\n");
      const racingFs = {
        ...fs,
        link: ((from: string, to: string) =>
          (to === `${f.local}/shared.txt`
            ? fs.writeFileString(to, "unique late edit\n")
            : Effect.void
          ).pipe(Effect.andThen(fs.link(from, to)))) as typeof fs.link,
      };
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f, dispatchFails: true })
          .move()
          .pipe(Effect.provideService(FileSystem.FileSystem, racingFs)),
      );
      expectCode(exit, "operation_failed");
      expect(yield* fs.readFileString(`${f.local}/shared.txt`)).toBe("unique late edit\n");
      expect(JSON.stringify(exit)).toContain("left as they are: shared.txt");
    }).pipe(Effect.provide(gitLayer)),
  );
});

const failureMessage = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? String((exit.cause.reasons[0].error as { message?: unknown }).message)
    : "";
const recoveryFolder = (exit: Exit.Exit<unknown, unknown>) =>
  /is under '([^']+)'/.exec(failureMessage(exit))?.[1];

describe("rollback restores", () => {
  it.effect("a deleted tracked file whose folder the move removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.makeDirectory(`${f.worktree}/nested`);
      yield* fs.writeFileString(`${f.worktree}/nested/leaf.txt`, "leaf\n");
      yield* f.git(f.worktree, ["add", "nested/leaf.txt"]);
      yield* f.git(f.worktree, ["commit", "-m", "nested leaf"]);
      yield* f.git(f.worktree, ["rm", "-q", "nested/leaf.txt"]);
      expectCode(
        yield* Effect.exit(makeHarness({ fixture: f, dispatchFails: true }).move()),
        "operation_failed",
      );
      yield* expectUntouched(f);
      expect(yield* f.git(f.local, ["status", "--porcelain=v1"])).toBe("");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("a repository file named like the scratch folder, kept with a late edit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.makeDirectory(`${f.worktree}/head-versions`);
      yield* fs.writeFileString(`${f.worktree}/head-versions/only.txt`, "source snapshot\n");
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "carried shared edit\n");
      yield* f.git(f.worktree, ["add", "head-versions/only.txt"]);
      const racingFs = {
        ...fs,
        rename: ((from: string, to: string) =>
          (from === `${f.local}/head-versions/only.txt`
            ? fs.writeFileString(from, "unique edit during rollback\n")
            : Effect.void
          ).pipe(Effect.andThen(fs.rename(from, to)))) as typeof fs.rename,
      };
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f, dispatchFails: true })
          .move()
          .pipe(Effect.provideService(FileSystem.FileSystem, racingFs)),
      );
      expectCode(exit, "operation_failed");
      expect(yield* fs.readFileString(`${recoveryFolder(exit)}/files/head-versions/only.txt`)).toBe(
        "unique edit during rollback\n",
      );
      expect(yield* f.git(f.local, ["status", "--porcelain=v1"])).toBe("");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("an index-only added file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.writeFileString(`${f.worktree}/added.txt`, "index-only new file\n");
      yield* f.git(f.worktree, ["add", "added.txt"]);
      yield* fs.remove(`${f.worktree}/added.txt`);
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "carried shared edit\n");
      const exit = yield* Effect.exit(makeHarness({ fixture: f, dispatchFails: true }).move());
      expectCode(exit, "operation_failed");
      expect(failureMessage(exit)).not.toContain("also failed");
      expect(yield* f.git(f.local, ["status", "--porcelain=v1"])).toBe("");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("executable bits and symlinks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const driver = yield* instrument((input, execute) =>
        execute({ ...input, args: ["-c", "core.filemode=true", ...input.args] }),
      );
      const f = yield* makeFixture().pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* fs.writeFileString(`${f.worktree}/run.sh`, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(`${f.worktree}/run.sh`, 0o755);
      yield* fs.symlink("shared.txt", `${f.worktree}/shortcut`);
      yield* f.git(f.worktree, ["add", "."]);
      yield* f.git(f.worktree, ["commit", "-m", "executable and symlink baseline"]);
      yield* fs.writeFileString(`${f.worktree}/run.sh`, "#!/bin/sh\nexit 1\n");
      yield* fs.remove(`${f.worktree}/shortcut`);
      yield* fs.symlink("feature.txt", `${f.worktree}/shortcut`);
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f, dispatchFails: true })
          .move()
          .pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver)),
      );
      expectCode(exit, "operation_failed");
      yield* expectUntouched(f);
      expect(yield* f.git(f.local, ["status", "--porcelain=v1"])).toBe("");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("203 carried files with tabs, newlines and wildcards in their names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const names = [
        ...Array.from({ length: 200 }, (_, i) => `batch-${String(i).padStart(3, "0")}.txt`),
        "tabs\tinside.txt",
        "two\nlines.txt",
        "literal*.txt",
      ];
      for (const name of names) yield* fs.writeFileString(`${f.worktree}/${name}`, `base\n`);
      yield* f.git(f.worktree, ["add", "."]);
      yield* f.git(f.worktree, ["commit", "-m", "batch baseline"]);
      for (const name of names) yield* fs.writeFileString(`${f.worktree}/${name}`, `carried\n`);
      expectCode(
        yield* Effect.exit(makeHarness({ fixture: f, dispatchFails: true }).move()),
        "operation_failed",
      );
      yield* expectUntouched(f);
      expect(yield* f.git(f.local, ["status", "--porcelain=v1"])).toBe("");
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("repository identity", () => {
  it.effect("refuses a worktree from a different repository with the same branch name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const other = `${f.root}/unrelated`;
      yield* fs.makeDirectory(other);
      yield* f.git(other, ["init", "-b", "feature"]);
      yield* f.git(other, ["config", "user.name", "Other"]);
      yield* f.git(other, ["config", "user.email", "other@example.test"]);
      yield* fs.writeFileString(`${other}/unrelated.txt`, "another repository\n");
      yield* f.git(other, ["add", "."]);
      yield* f.git(other, ["commit", "-m", "unrelated"]);
      yield* f.git(f.worktree, ["switch", "--detach"]);
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f, threadWorktreePath: other }).move(),
      );
      expectCode(exit, "different_repository");
      expect(yield* currentBranch(f, f.local)).toBe("main");
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect.each(["root", "subfolder"])(
    "moves repository-relative paths when the thread's worktree path is its %s",
    (sourceKind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeFixture();
        yield* fs.makeDirectory(`${f.local}/nested`);
        yield* fs.makeDirectory(`${f.worktree}/nested`);
        yield* fs.writeFileString(`${f.worktree}/nested/new.txt`, "nested untracked\n");
        yield* fs.writeFileString(`${f.worktree}/outside.txt`, "root untracked\n");
        const result = yield* makeHarness({
          fixture: { ...f, local: `${f.local}/nested` },
          threadWorktreePath: sourceKind === "root" ? f.worktree : `${f.worktree}/nested`,
        }).move();
        expect(result.localCheckoutPath).toBe(`${f.local}/nested`);
        expect(yield* fs.readFileString(`${f.local}/nested/new.txt`)).toBe("nested untracked\n");
        expect(yield* fs.readFileString(`${f.local}/outside.txt`)).toBe("root untracked\n");
        expect(yield* fs.exists(`${f.local}/nested/nested`)).toBe(false);
      }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("treats a running thread at the repository root as busy for a subfolder project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.makeDirectory(`${f.local}/nested`);
      const exit = yield* Effect.exit(
        makeHarness({
          fixture: { ...f, local: `${f.local}/nested` },
          others: [
            { id: "root", title: "Busy at repo root", worktreePath: f.local, running: true },
          ],
        }).move(),
      );
      expectCode(exit, "local_checkout_busy");
      yield* expectUntouched(f);
    }).pipe(Effect.provide(gitLayer)),
  );
  it.effect("never removes an outside file when the copy target becomes a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const victim = `${f.root}/outside-victim.txt`;
      const target = `${f.local}/new.txt`;
      yield* fs.writeFileString(victim, "external unique data\n");
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "source file\n");
      const racingFs = {
        ...fs,
        realPath: ((name: string) =>
          (name === target
            ? fs.remove(target).pipe(Effect.andThen(fs.symlink(victim, target)))
            : Effect.void
          ).pipe(Effect.andThen(fs.realPath(name)))) as typeof fs.realPath,
      };
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f })
          .move()
          .pipe(Effect.provideService(FileSystem.FileSystem, racingFs)),
      );
      expectCode(exit, "operation_failed");
      expect(yield* fs.readFileString(victim)).toBe("external unique data\n");
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("checkouts and layouts", () => {
  it.effect.each(["--assume-unchanged", "--skip-worktree"])(
    "preserves hidden local edits marked %s when the target branch changes the file",
    (flag) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeFixture();
        yield* fs.writeFileString(`${f.worktree}/shared.txt`, "feature committed version\n");
        yield* f.git(f.worktree, ["add", "shared.txt"]);
        yield* f.git(f.worktree, ["commit", "-m", "change shared file"]);
        yield* f.git(f.local, ["update-index", flag, "shared.txt"]);
        yield* fs.writeFileString(`${f.local}/shared.txt`, "unique local user data\n");
        expect(yield* f.git(f.local, ["status", "--porcelain"])).toBe("");
        const exit = yield* Effect.exit(makeHarness({ fixture: f }).move());
        expect({
          exit: exit._tag,
          local: yield* fs.readFileString(`${f.local}/shared.txt`),
        }).toEqual({ exit: "Failure", local: "unique local user data\n" });
        yield* expectUntouched(f);
      }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("moves into a linked checkout rather than the main repository checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      const target = `${f.root}/linked-local`;
      yield* f.git(f.local, ["worktree", "add", "-b", "other", target]);
      yield* fs.writeFileString(`${f.worktree}/shared.txt`, "carried\n");
      yield* fs.writeFileString(`${f.worktree}/new.txt`, "new\n");
      const result = yield* makeHarness({ fixture: { ...f, local: target } }).move();
      expect(result.localCheckoutPath).toBe(target);
      expect(yield* fs.readFileString(`${target}/shared.txt`)).toBe("carried\n");
      expect(yield* fs.readFileString(`${target}/new.txt`)).toBe("new\n");
      expect(yield* currentBranch(f, f.local)).toBe("main");
      expect(yield* currentBranch(f, f.worktree)).toBe("HEAD");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("carries a tracked change outside the destination sparse checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.makeDirectory(`${f.worktree}/included`);
      yield* fs.makeDirectory(`${f.worktree}/excluded`);
      yield* fs.writeFileString(`${f.worktree}/included/a.txt`, "base included\n");
      yield* fs.writeFileString(`${f.worktree}/excluded/b.txt`, "base excluded\n");
      yield* f.git(f.worktree, ["add", "."]);
      yield* f.git(f.worktree, ["commit", "-m", "folders"]);
      yield* f.git(f.local, ["sparse-checkout", "set", "included"]);
      yield* fs.writeFileString(`${f.worktree}/excluded/b.txt`, "carried outside sparse\n");
      const result = yield* makeHarness({ fixture: f }).move();
      expect(result.carriedChanges).toBe(true);
      expect(yield* fs.readFileString(`${f.local}/excluded/b.txt`)).toBe(
        "carried outside sparse\n",
      );
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("checkout ownership and complete copies", () => {
  it.effect("refuses a running local thread belonging to another project in the repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.makeDirectory(`${f.local}/nested`);
      const h = makeHarness({
        fixture: { ...f, local: `${f.local}/nested` },
        projectRoots: { "other-project": f.local },
        others: [
          {
            id: "other-project-thread",
            title: "Busy in root project",
            projectId: "other-project",
            worktreePath: null,
            running: true,
          },
        ],
      });
      const exit = yield* Effect.exit(h.move());
      expect({ exit: exit._tag, branch: yield* currentBranch(f, f.local) }).toEqual({
        exit: "Failure",
        branch: "main",
      });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect(
    "refuses a worktree sharer stored at the root when the moving thread stores a subfolder",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeFixture();
        yield* fs.makeDirectory(`${f.worktree}/nested`);
        const h = makeHarness({
          fixture: f,
          threadWorktreePath: `${f.worktree}/nested`,
          others: [
            {
              id: "root-sharer",
              title: "Other worktree thread",
              worktreePath: f.worktree,
              running: true,
            },
          ],
        });
        const exit = yield* Effect.exit(h.move());
        expect({ exit: exit._tag, branch: yield* currentBranch(f, f.worktree) }).toEqual({
          exit: "Failure",
          branch: "feature",
        });
      }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("serializes moves into different project subfolders of the same checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.makeDirectory(`${f.local}/a`);
      yield* fs.makeDirectory(`${f.local}/b`);
      const otherWorktree = `${f.root}/other-worktree`;
      yield* f.git(f.local, ["worktree", "add", "-b", "other-feature", otherWorktree]);
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const first = makeHarness({
        fixture: { ...f, local: `${f.local}/a` },
        id: "first",
        project: "project-a",
        dispatchGate: Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
      });
      const second = makeHarness({
        fixture: { ...f, local: `${f.local}/b`, worktree: otherWorktree },
        id: "second",
        project: "project-b",
        threadBranch: "other-feature",
      });
      const fiber = yield* Effect.forkChild(first.move());
      yield* Deferred.await(reached);
      const secondExit = yield* Effect.exit(second.move());
      yield* Deferred.succeed(gate, undefined);
      const firstResult = yield* Fiber.join(fiber);
      expect({
        second: secondExit._tag,
        firstReportedBranch: firstResult.branch,
        actualBranch: yield* currentBranch(f, f.local),
      }).toEqual({ second: "Failure", firstReportedBranch: "feature", actualBranch: "feature" });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses truncated status rather than silently leaving new files behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      for (const name of ["a1.txt", "a2.txt", "a3.txt"])
        yield* fs.writeFileString(`${f.worktree}/${name}`, "new file\n");
      const driver = yield* instrument((input, execute) =>
        execute({
          ...input,
          ...(input.operation === "ThreadLocalCheckout.worktreeStatus"
            ? { maxOutputBytes: 20 }
            : {}),
        }),
      );
      const h = makeHarness({ fixture: f });
      const exit = yield* Effect.exit(
        h.move().pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver)),
      );
      expectCode(exit, "operation_failed");
      expect(JSON.stringify(exit)).toContain("output exceeded 20 bytes");
      expect({
        exit: exit._tag,
        thirdFileCopied: yield* fs.exists(`${f.local}/a3.txt`),
        threadRepointed: h.thread.worktreePath === null,
      }).toEqual({ exit: "Failure", thirdFileCopied: false, threadRepointed: false });
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("local hidden changes versus snapshot application", () => {
  it.effect.each(["--assume-unchanged", "--skip-worktree"])(
    "preserves hidden local edits marked %s when only the snapshot changes that file",
    (flag) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const f = yield* makeFixture();
        yield* fs.writeFileString(`${f.worktree}/shared.txt`, "worktree uncommitted changes\n");
        yield* f.git(f.local, ["update-index", flag, "shared.txt"]);
        yield* fs.writeFileString(`${f.local}/shared.txt`, "unique hidden local user data\n");
        expect(yield* f.git(f.local, ["status", "--porcelain"])).toBe("");
        const h = makeHarness({ fixture: f });
        const exit = yield* Effect.exit(h.move());
        expect({
          exit: exit._tag,
          local: yield* fs.readFileString(`${f.local}/shared.txt`),
          threadRepointed: h.thread.worktreePath === null,
        }).toEqual({
          exit: "Failure",
          local: "unique hidden local user data\n",
          threadRepointed: false,
        });
      }).pipe(Effect.provide(gitLayer)),
  );
});

describe("recovery guidance", () => {
  it.effect("reports where a late file inside a renamed recovery folder actually went", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const f = yield* makeFixture();
      yield* fs.makeDirectory(`${f.worktree}/new-dir`);
      yield* fs.writeFileString(`${f.worktree}/new-dir/moving.txt`, "carried file\n");
      const racingFs = {
        ...fs,
        rename: ((from: string, to: string) =>
          (from === `${f.local}/new-dir`
            ? fs.writeFileString(`${from}/late-user.txt`, "unique late user data\n")
            : Effect.void
          ).pipe(Effect.andThen(fs.rename(from, to)))) as typeof fs.rename,
      };
      const exit = yield* Effect.exit(
        makeHarness({ fixture: f, dispatchFails: true })
          .move()
          .pipe(Effect.provideService(FileSystem.FileSystem, racingFs)),
      );
      expectCode(exit, "operation_failed");
      const message =
        Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
          ? String((exit.cause.reasons[0].error as { message: string }).message)
          : "";
      const reportedFolder = /is under '([^']+)'/.exec(message)?.[1];
      expect(reportedFolder).toBeDefined();
      expect(yield* fs.readFileString(`${reportedFolder}/folders/new-dir/late-user.txt`)).toBe(
        "unique late user data\n",
      );
      expect(yield* fs.exists(`${f.local}/new-dir/late-user.txt`)).toBe(false);
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("worktree sharing across projects", () => {
  it.effect("refuses when another project's folder is the worktree itself", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const h = makeHarness({
        fixture: f,
        projectRoots: { "worktree-project": f.worktree },
        others: [
          {
            id: "worktree-project-thread",
            title: "Thread in the worktree project",
            projectId: "worktree-project",
            worktreePath: null,
          },
        ],
      });
      const exit = yield* Effect.exit(h.move());
      expectCode(exit, "worktree_shared");
      expect(failureMessage(exit)).toContain("Thread in the worktree project");
      yield* expectUntouched(f);
    }).pipe(Effect.provide(gitLayer)),
  );
});
