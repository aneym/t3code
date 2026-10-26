import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type GitCommandError,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

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
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "move-to-local-git-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** A repo on `main` with `feature` checked out in a linked worktree one commit ahead. */
const makeFixture = Effect.fn("makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "move-to-local-" });
  const local = `${root}/repo`;
  const worktree = `${root}/worktrees/feature`;
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
  readonly threadBranch?: string | null;
  readonly threadWorktreePath?: string | null;
  readonly selfRunning?: boolean;
  readonly others?: ReadonlyArray<OtherThread>;
  readonly dispatchFails?: boolean;
  readonly dispatchGate?: Effect.Effect<void>;
}

const makeHarness = (options: HarnessOptions) => {
  const { fixture } = options;
  const thread = {
    id: threadId,
    projectId,
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
      projectId,
      title,
      worktreePath,
      archivedAt: archived ? DateTime.makeUnsafe(0) : null,
      activeRunId: running ? "run-active" : null,
    }) as unknown as OrchestrationV2ThreadShell;
  const shells = () => [
    shell(threadId, thread.title, thread.worktreePath, false, options.selfRunning ?? false),
    ...(options.others ?? []).map((other) =>
      shell(
        other.id,
        other.title,
        other.worktreePath,
        other.archived ?? false,
        other.running ?? false,
      ),
    ),
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

  const layer = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.succeed({ thread: { ...thread } } as unknown as OrchestrationV2ThreadProjection),
      listProjectThreads: () => Effect.succeed(shells().filter((item) => item.archivedAt === null)),
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [],
          archivedThreads: shells().filter((item) => item.archivedAt !== null),
        } as never),
      dispatch: dispatch as never,
    } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: projectId,
          title: "Project",
          workspaceRoot: fixture.local,
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
    ThreadLocalCheckout.moveThreadToLocalCheckout({ threadId, ...input }).pipe(
      Effect.provide(layer),
    );

  return { thread, dispatch, move };
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

describe("moveThreadToLocalCheckout", () => {
  it.effect("moves a clean worktree branch into the local checkout and deletes the worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const harness = makeHarness({ fixture });

      const result = yield* harness.move();

      expect(result).toMatchObject({
        branch: "feature",
        localCheckoutPath: fixture.local,
        previousWorktreePath: fixture.worktree,
        previousLocalBranch: "main",
        carriedChanges: false,
        worktree: { status: "removed" },
      });
      expect(yield* currentBranch(fixture, fixture.local)).toBe("feature");
      expect(yield* fs.readFileString(`${fixture.local}/feature.txt`)).toBe("feature\n");
      expect(yield* fs.exists(fixture.worktree)).toBe(false);
      expect(yield* fixture.git(fixture.local, ["worktree", "list", "--porcelain"])).not.toContain(
        fixture.worktree,
      );
      expect(harness.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.metadata.update",
          threadId,
          branch: "feature",
          worktreePath: null,
          expectedWorktreePath: fixture.worktree,
        }),
      );
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("carries staged, unstaged and untracked changes and keeps the staging", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      yield* fs.writeFileString(`${fixture.worktree}/shared.txt`, "staged edit\n");
      yield* fixture.git(fixture.worktree, ["add", "shared.txt"]);
      yield* fs.writeFileString(`${fixture.worktree}/feature.txt`, "unstaged edit\n");
      yield* fs.makeDirectory(`${fixture.worktree}/notes/deep`, { recursive: true });
      yield* fs.writeFileString(`${fixture.worktree}/notes/deep/todo.md`, "untracked\n");
      const harness = makeHarness({ fixture });

      const result = yield* harness.move();

      expect(result.carriedChanges).toBe(true);
      expect(yield* currentBranch(fixture, fixture.local)).toBe("feature");
      expect(yield* fixture.git(fixture.local, ["diff", "--cached", "--name-only"])).toBe(
        "shared.txt",
      );
      expect(yield* fixture.git(fixture.local, ["diff", "--name-only"])).toBe("feature.txt");
      expect(yield* fs.readFileString(`${fixture.local}/shared.txt`)).toBe("staged edit\n");
      expect(yield* fs.readFileString(`${fixture.local}/feature.txt`)).toBe("unstaged edit\n");
      expect(yield* fs.readFileString(`${fixture.local}/notes/deep/todo.md`)).toBe("untracked\n");
      expect(yield* stashCount(fixture)).toBe(0);
      expect(result.worktree).toEqual({ status: "removed" });
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("keeps an unrelated stash entry untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      yield* fs.writeFileString(`${fixture.local}/shared.txt`, "user stash\n");
      yield* fixture.git(fixture.local, ["stash", "push", "-m", "user work"]);
      yield* fs.writeFileString(`${fixture.worktree}/feature.txt`, "edit\n");
      const harness = makeHarness({ fixture });

      yield* harness.move();

      expect(yield* fixture.git(fixture.local, ["stash", "list", "--format=%s"])).toBe(
        "On main: user work",
      );
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses when the local checkout has tracked changes and changes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      yield* fs.writeFileString(`${fixture.local}/shared.txt`, "local edit\n");
      yield* fs.writeFileString(`${fixture.worktree}/feature.txt`, "wt edit\n");
      const harness = makeHarness({ fixture });

      expectCode(yield* Effect.exit(harness.move()), "local_checkout_dirty");
      yield* expectUntouched(fixture);
      expect(yield* fs.readFileString(`${fixture.worktree}/feature.txt`)).toBe("wt edit\n");
      expect(harness.dispatch).not.toHaveBeenCalled();
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("allows untracked files in the local checkout that do not collide", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      yield* fs.writeFileString(`${fixture.local}/scratch.log`, "mine\n");
      const harness = makeHarness({ fixture });

      yield* harness.move();

      expect(yield* currentBranch(fixture, fixture.local)).toBe("feature");
      expect(yield* fs.readFileString(`${fixture.local}/scratch.log`)).toBe("mine\n");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses when an untracked worktree file already exists in the checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      yield* fs.writeFileString(`${fixture.worktree}/draft.md`, "worktree\n");
      yield* fs.writeFileString(`${fixture.local}/draft.md`, "local\n");
      const harness = makeHarness({ fixture });

      expectCode(yield* Effect.exit(harness.move()), "untracked_collision");
      yield* expectUntouched(fixture);
      expect(yield* fs.readFileString(`${fixture.local}/draft.md`)).toBe("local\n");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("rolls back when the branch would overwrite an untracked file in the checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      // `feature` tracks feature.txt; an untracked copy in the checkout blocks `git switch`.
      yield* fs.writeFileString(`${fixture.local}/feature.txt`, "local untracked\n");
      yield* fs.writeFileString(`${fixture.worktree}/shared.txt`, "wt edit\n");
      yield* fs.writeFileString(`${fixture.worktree}/new.txt`, "wt untracked\n");
      const harness = makeHarness({ fixture });

      expectCode(yield* Effect.exit(harness.move()), "operation_failed");
      yield* expectUntouched(fixture);
      expect(yield* fs.readFileString(`${fixture.worktree}/shared.txt`)).toBe("wt edit\n");
      expect(yield* fs.readFileString(`${fixture.worktree}/new.txt`)).toBe("wt untracked\n");
      expect(yield* fs.readFileString(`${fixture.local}/feature.txt`)).toBe("local untracked\n");
      expect(harness.dispatch).not.toHaveBeenCalled();
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("rolls everything back when the thread cannot be re-pointed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      yield* fs.writeFileString(`${fixture.worktree}/shared.txt`, "staged\n");
      yield* fixture.git(fixture.worktree, ["add", "shared.txt"]);
      yield* fs.writeFileString(`${fixture.worktree}/untracked.txt`, "untracked\n");
      const harness = makeHarness({ fixture, dispatchFails: true });

      expectCode(yield* Effect.exit(harness.move()), "operation_failed");
      yield* expectUntouched(fixture);
      expect(yield* fixture.git(fixture.worktree, ["diff", "--cached", "--name-only"])).toBe(
        "shared.txt",
      );
      expect(yield* fs.readFileString(`${fixture.worktree}/untracked.txt`)).toBe("untracked\n");
      expect(yield* fs.exists(`${fixture.local}/untracked.txt`)).toBe(false);
      expect(yield* fixture.git(fixture.local, ["status", "--porcelain"])).toBe("");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("restores a detached local HEAD on rollback", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const head = yield* fixture.git(fixture.local, ["rev-parse", "HEAD"]);
      yield* fixture.git(fixture.local, ["switch", "--detach", "HEAD"]);
      const harness = makeHarness({ fixture, dispatchFails: true });

      expectCode(yield* Effect.exit(harness.move()), "operation_failed");
      expect(yield* currentBranch(fixture, fixture.local)).toBe("HEAD");
      expect(yield* fixture.git(fixture.local, ["rev-parse", "HEAD"])).toBe(head);
      expect(yield* currentBranch(fixture, fixture.worktree)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("moves from a detached local HEAD and reports no previous branch", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.git(fixture.local, ["switch", "--detach", "HEAD"]);
      const harness = makeHarness({ fixture });

      const result = yield* harness.move();

      expect(result.previousLocalBranch).toBeNull();
      expect(yield* currentBranch(fixture, fixture.local)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses while the thread is running unless its own agent asks", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const harness = makeHarness({ fixture, selfRunning: true });

      expectCode(yield* Effect.exit(harness.move()), "thread_running");
      yield* expectUntouched(fixture);

      const result = yield* harness.move({ allowActiveRun: true });
      expect(result.branch).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses while another thread is working in the local checkout", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const harness = makeHarness({
        fixture,
        others: [{ id: "busy", title: "Busy local thread", worktreePath: null, running: true }],
      });

      const exit = yield* Effect.exit(harness.move());
      expectCode(exit, "local_checkout_busy");
      expect(JSON.stringify(exit)).toContain("Busy local thread");
      yield* expectUntouched(fixture);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("ignores idle local threads and running threads in other worktrees", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const harness = makeHarness({
        fixture,
        others: [
          { id: "idle", title: "Idle local", worktreePath: null },
          { id: "elsewhere", title: "Other worktree", worktreePath: "/elsewhere", running: true },
        ],
      });

      yield* harness.move();
      expect(yield* currentBranch(fixture, fixture.local)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses when another active thread uses the same worktree", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const harness = makeHarness({
        fixture,
        others: [{ id: "sibling", title: "Sibling", worktreePath: fixture.worktree }],
      });

      expectCode(yield* Effect.exit(harness.move()), "worktree_shared");
      yield* expectUntouched(fixture);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("keeps the worktree folder when an archived thread still points at it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const harness = makeHarness({
        fixture,
        others: [
          { id: "archived", title: "Archived", worktreePath: fixture.worktree, archived: true },
        ],
      });

      const result = yield* harness.move();

      expect(result.worktree).toEqual({ status: "kept", reason: "shared_with_archived_thread" });
      expect(yield* fs.exists(fixture.worktree)).toBe(true);
      expect(yield* currentBranch(fixture, fixture.worktree)).toBe("HEAD");
      expect(yield* currentBranch(fixture, fixture.local)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("keeps the worktree folder detached when asked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const harness = makeHarness({ fixture });

      const result = yield* harness.move({ removeWorktree: false });

      expect(result.worktree).toEqual({ status: "kept", reason: "requested" });
      expect(yield* fs.exists(fixture.worktree)).toBe(true);
      expect(yield* currentBranch(fixture, fixture.worktree)).toBe("HEAD");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("deletes ignored files with the worktree folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      yield* fs.makeDirectory(`${fixture.worktree}/ignored`, { recursive: true });
      yield* fs.writeFileString(`${fixture.worktree}/ignored/cache.bin`, "cache\n");
      const harness = makeHarness({ fixture });

      const result = yield* harness.move();

      expect(result).toMatchObject({ carriedChanges: false, worktree: { status: "removed" } });
      expect(yield* fs.exists(fixture.worktree)).toBe(false);
      expect(yield* fs.exists(`${fixture.local}/ignored/cache.bin`)).toBe(false);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("moves the thread's branch when the worktree folder was already deleted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      yield* fs.remove(fixture.worktree, { recursive: true });
      const harness = makeHarness({ fixture });

      const result = yield* harness.move();

      expect(result.worktree).toEqual({ status: "kept", reason: "missing" });
      expect(yield* currentBranch(fixture, fixture.local)).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses a detached worktree HEAD", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.git(fixture.worktree, ["switch", "--detach"]);
      const harness = makeHarness({ fixture });

      expectCode(yield* Effect.exit(harness.move()), "worktree_detached");
      expect(yield* currentBranch(fixture, fixture.local)).toBe("main");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses a worktree with unresolved conflicts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      yield* fs.writeFileString(`${fixture.local}/shared.txt`, "main side\n");
      yield* fixture.git(fixture.local, ["commit", "-am", "main change"]);
      yield* fs.writeFileString(`${fixture.worktree}/shared.txt`, "feature side\n");
      yield* fixture.git(fixture.worktree, ["commit", "-am", "feature change"]);
      yield* Effect.exit(fixture.git(fixture.worktree, ["merge", "main"]));
      const harness = makeHarness({ fixture });

      expectCode(yield* Effect.exit(harness.move()), "worktree_conflicted");
      expect(yield* currentBranch(fixture, fixture.local)).toBe("main");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses while the local checkout is mid-merge", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const gitDir = yield* fixture.git(fixture.local, ["rev-parse", "--absolute-git-dir"]);
      const head = yield* fixture.git(fixture.local, ["rev-parse", "HEAD"]);
      yield* fs.writeFileString(`${gitDir}/MERGE_HEAD`, `${head}\n`);
      const harness = makeHarness({ fixture });

      expectCode(yield* Effect.exit(harness.move()), "local_operation_in_progress");
      yield* fs.remove(`${gitDir}/MERGE_HEAD`);
      yield* expectUntouched(fixture);
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("refuses a thread that already works in the local checkout", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const harness = makeHarness({ fixture, threadWorktreePath: null });

      expectCode(yield* Effect.exit(harness.move()), "not_in_worktree");
    }).pipe(Effect.provide(gitLayer)),
  );

  it.effect("lets only one move into a checkout run at a time", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const reached = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const first = makeHarness({
        fixture,
        dispatchGate: Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
        ),
      });
      const second = makeHarness({ fixture });

      const fiber = yield* Effect.forkChild(first.move());
      yield* Deferred.await(reached);
      expectCode(yield* Effect.exit(second.move()), "move_in_progress");
      yield* Deferred.succeed(gate, undefined);
      const result = yield* Fiber.join(fiber);
      expect(result.branch).toBe("feature");
    }).pipe(Effect.provide(gitLayer)),
  );
});

describe("parsePorcelainStatus", () => {
  it("skips the source path of renames", () => {
    expect(
      ThreadLocalCheckout.parsePorcelainStatus("R  new.txt\0old.txt\0?? notes.md\0 M a.txt\0"),
    ).toEqual([
      { code: "R ", path: "new.txt" },
      { code: "??", path: "notes.md" },
      { code: " M", path: "a.txt" },
    ]);
  });
});
