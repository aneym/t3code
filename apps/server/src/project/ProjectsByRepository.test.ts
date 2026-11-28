import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type Project } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { agentHomeKeysOfRoot, isAgentShellHomePath } from "../agents/AgentHomeOfPath.ts";
import type * as ProjectService from "./ProjectService.ts";
import { projectsMatchingAgentHome } from "./ProjectsByRepository.ts";

const swapAgentHomesDir = (next: string | undefined): string | undefined => {
  const prev = process.env.T3CODE_AGENT_HOMES_DIR;
  if (next === undefined) delete process.env.T3CODE_AGENT_HOMES_DIR;
  else process.env.T3CODE_AGENT_HOMES_DIR = next;
  return prev;
};

const makeProject = (
  id: string,
  workspaceRoot: string,
  overrides: Partial<Project> = {},
): Project => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-28T00:00:00.000Z",
  updatedAt: "2026-11-28T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const mockProjects = (list: ReadonlyArray<Project>): ProjectService.ProjectService["Service"] =>
  ({
    listPage: () => Effect.succeed({ projects: list, nextCursor: null }),
  }) as unknown as ProjectService.ProjectService["Service"];

const withTempAgentRoot = <A, E, R>(
  run: (root: string, path: Path.Path) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-homes-" });
    const agentsDir = path.join(root, "agents");
    const shellsDir = path.join(root, "shells");
    yield* fs.makeDirectory(path.join(agentsDir, "factory", "executor"), { recursive: true });
    yield* fs.makeDirectory(path.join(shellsDir, "factory", "executor"), { recursive: true });
    yield* fs.makeDirectory(path.join(agentsDir, "bot", "executor"), { recursive: true });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => swapAgentHomesDir(agentsDir)),
      () => run(root, path),
      (prev) => Effect.sync(() => void swapAgentHomesDir(prev)),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("projectsMatchingAgentHome", () => {
  it.effect(
    "prefers live shells/<handle> over stale agents/<handle> when both are registered",
    () =>
      withTempAgentRoot((root, path) =>
        Effect.gen(function* () {
          const staleAgent = path.join(root, "agents", "factory");
          const liveShell = path.join(root, "shells", "factory");
          const staleExecutor = path.join(root, "agents", "factory", "executor");
          const liveExecutor = path.join(root, "shells", "factory", "executor");

          const homeKeys = yield* Effect.promise(() => agentHomeKeysOfRoot(staleAgent));
          const executorKeys = yield* Effect.promise(() => agentHomeKeysOfRoot(staleExecutor));

          const store = mockProjects([
            makeProject("proj:stale-agent", staleAgent),
            makeProject("proj:live-shell", liveShell),
            makeProject("proj:stale-exec", staleExecutor),
            makeProject("proj:live-exec", liveExecutor),
          ]);

          const matchedHome = yield* projectsMatchingAgentHome(store, new Set(homeKeys));
          const matchedExec = yield* projectsMatchingAgentHome(store, new Set(executorKeys));

          assert.deepEqual(
            matchedHome.matches.map((project) => project.id),
            [ProjectId.make("proj:live-shell")],
          );
          assert.deepEqual(
            matchedExec.matches.map((project) => project.id),
            [ProjectId.make("proj:live-exec")],
          );
          assert.isTrue(isAgentShellHomePath(liveShell));
          assert.isTrue(isAgentShellHomePath(liveExecutor));
          assert.isFalse(isAgentShellHomePath(staleAgent));
        }),
      ),
  );

  it.effect("filters archived duplicates and matches single agents/<handle>/executor cleanly", () =>
    withTempAgentRoot((root, path) =>
      Effect.gen(function* () {
        const botExec = path.join(root, "agents", "bot", "executor");
        const factoryShellExec = path.join(root, "shells", "factory", "executor");
        const factoryAgentExec = path.join(root, "agents", "factory", "executor");

        const botKeys = yield* Effect.promise(() => agentHomeKeysOfRoot(botExec));
        const factoryKeys = yield* Effect.promise(() => agentHomeKeysOfRoot(factoryAgentExec));

        const store = mockProjects([
          makeProject("proj:bot-exec", botExec),
          makeProject("proj:factory-active", factoryAgentExec),
          makeProject("proj:factory-archived-shell", factoryShellExec, {
            archivedAt: "2026-11-27T00:00:00.000Z",
          }),
        ]);

        const matchedBot = yield* projectsMatchingAgentHome(store, new Set(botKeys));
        const matchedFactory = yield* projectsMatchingAgentHome(store, new Set(factoryKeys));

        assert.deepEqual(
          matchedBot.matches.map((project) => project.id),
          [ProjectId.make("proj:bot-exec")],
        );
        assert.deepEqual(
          matchedFactory.matches.map((project) => project.id),
          [ProjectId.make("proj:factory-active")],
        );
      }),
    ),
  );
});
