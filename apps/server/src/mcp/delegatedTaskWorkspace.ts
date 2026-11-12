import type { OrchestratorMcpDelegateTaskInput, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProjectService from "../project/ProjectService.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { failure } from "./threadManagementFailure.ts";

interface Services {
  readonly projects: ProjectService.ProjectService["Service"];
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
}

interface ParentCheckout {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

type Request = Pick<OrchestratorMcpDelegateTaskInput, "target" | "isolation" | "baseRef">;

const defaultBranchRevisions = Effect.fn("DelegatedTaskWorkspace.defaultBranchRevisions")(
  function* (git: Services["git"], cwd: string) {
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
    const branch =
      remote === null
        ? null
        : yield* git.resolveDefaultBranchName(cwd, remote).pipe(Effect.orElseSucceed(() => null));
    return branch === null ? ["HEAD"] : [branch, `${remote}/${branch}`, "HEAD"];
  },
);

const firstCommit = Effect.fn("DelegatedTaskWorkspace.firstCommit")(function* (
  git: Services["git"],
  cwd: string,
  revisions: ReadonlyArray<string>,
) {
  for (const revision of revisions) {
    const commit = yield* git.resolveCommit({ cwd, revision }).pipe(
      Effect.map((resolved) => resolved.commitSha),
      Effect.orElseSucceed(() => undefined),
    );
    if (commit !== undefined) return commit;
  }
  return undefined;
});

export const resolveDelegatedTaskWorkspace = Effect.fn("DelegatedTaskWorkspace.resolve")(function* (
  { projects, git }: Services,
  parent: ParentCheckout,
  input: Request,
  replay: boolean,
) {
  const projectId = input.target?.projectId ?? parent.projectId;
  const crossProject = projectId !== parent.projectId;
  const command = crossProject ? { projectId } : {};
  if (input.baseRef !== undefined && input.isolation !== "worktree") {
    return yield* failure("invalid_request", `baseRef needs isolation "worktree".`);
  }
  if (replay || (!crossProject && input.isolation !== "worktree")) return { projectId, command };
  const project = yield* projects.getById(projectId).pipe(
    Effect.mapError((error) =>
      failure("orchestration_error", `Unable to read project ${projectId}: ${error.message}`),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            failure(
              "invalid_request",
              `Project ${projectId} is not on this environment. t3_project_list lists its projects; a project elsewhere needs target.environmentId.`,
            ),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
  if (input.isolation !== "worktree") return { projectId, command };
  const root = project.workspaceRoot;
  const cwd = crossProject ? root : (parent.worktreePath ?? root);
  const revisions =
    input.baseRef !== undefined
      ? [input.baseRef]
      : crossProject
        ? yield* defaultBranchRevisions(git, root)
        : ["HEAD"];
  const commit = yield* firstCommit(git, cwd, revisions);
  if (commit === undefined) {
    return yield* failure(
      "invalid_request",
      input.baseRef !== undefined
        ? `Base ref "${input.baseRef}" does not resolve to a commit in project "${project.title}" (${cwd}). Pass a branch, tag, or commit that exists there.`
        : crossProject
          ? `Isolation "worktree" needs project "${project.title}" (${root}) to be a git repository with a commit. Use isolation "shared" to work in its folder.`
          : `Isolation "worktree" needs this thread's checkout (${cwd}) to be a git repository with a commit, and it is not. Pass target.projectId (from t3_project_list) to run the child in a worktree of another project's repository, or use isolation "shared" to work in this folder.`,
    );
  }
  if (cwd !== root && (yield* firstCommit(git, root, [commit])) === undefined) {
    return yield* failure(
      "invalid_request",
      `Isolation "worktree" creates the child checkout in project "${project.title}" (${root}), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
    );
  }
  return {
    projectId,
    command: {
      ...command,
      workspaceStrategy: { type: "worktree" as const, baseRef: commit, startFromOrigin: false },
    },
  };
});
