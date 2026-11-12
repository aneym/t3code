import {
  type EnvironmentId,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  type OrchestrationV2RemoteTaskChild,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Tool from "effect/ai/Tool";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { WorktreeToolkit } from "../mcp/toolkits/worktree/tools.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as WorktreeTransfer from "./WorktreeTransfer.ts";

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;
type LaunchParams = Tool.Parameters<typeof ProjectToolkit.tools.t3_thread_launch>;
type LaunchResult = Tool.Success<typeof ProjectToolkit.tools.t3_thread_launch>;
type WorkspaceRequest = Pick<OrchestratorMcpDelegateTaskInput, "isolation" | "baseRef">;
interface ParentCheckout {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

const COMMIT_ONLY =
  "\n\nCommit your work on this worktree's branch before you finish. Only commits go back to the task's parent.";

export class RemoteWorktreeTask extends Context.Service<
  RemoteWorktreeTask,
  {
    readonly launch: (
      scope: ThreadScope,
      environmentId: EnvironmentId,
      parent: ParentCheckout,
      request: WorkspaceRequest,
      params: LaunchParams,
    ) => Effect.Effect<
      { readonly launched: LaunchResult; readonly worktreeBase?: string },
      OrchestratorMcpFailure
    >;
    readonly withWork: (
      scope: ThreadScope,
      remote: OrchestrationV2RemoteTaskChild,
      parent: ParentCheckout,
      taskId: string,
      reply: string,
    ) => Effect.Effect<string, OrchestratorMcpFailure>;
  }
>()("t3/peer/RemoteWorktreeTask") {}

const make = Effect.gen(function* () {
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const projects = yield* ProjectService.ProjectService;
  const transfer = yield* WorktreeTransfer.WorktreeTransfer;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  const checkoutOf = (parent: ParentCheckout) =>
    parent.worktreePath === null
      ? projects.getById(parent.projectId).pipe(
          Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.succeed(parent.worktreePath);

  const repositoryKeyThere = Effect.fn("RemoteWorktreeTask.repositoryKeyThere")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) {
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> =
        yield* forwarding.call(scope, ProjectToolkit.tools.t3_project_list, environmentId, {
          cursor,
          limit: 100,
        });
      const project = listed.projects.find((candidate) => candidate.id === projectId);
      if (project !== undefined) return project.repositoryIdentity?.canonicalKey;
      cursor = listed.nextCursor;
    }
    return undefined;
  });

  const launch: RemoteWorktreeTask["Service"]["launch"] = Effect.fn("RemoteWorktreeTask.launch")(
    function* (scope, environmentId, parent, request, params) {
      const launchOn = (baseRef: string | undefined) =>
        forwarding.call(scope, ProjectToolkit.tools.t3_thread_launch, environmentId, {
          ...params,
          ...(baseRef === undefined
            ? {}
            : { workspaceStrategy: { type: "worktree" as const, baseRef, startFromOrigin: true } }),
        });
      if (request.isolation !== "worktree") {
        if (request.baseRef !== undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `baseRef needs isolation "worktree".`,
          });
        return { launched: yield* launchOn(undefined) };
      }
      if (request.baseRef !== undefined) return { launched: yield* launchOn(request.baseRef) };
      const cwd = yield* checkoutOf(parent);
      const commitBase =
        cwd === undefined
          ? undefined
          : yield* transfer.resolveBase(cwd).pipe(Effect.orElseSucceed(() => undefined));
      const targetKey =
        commitBase === undefined || params.projectId === undefined
          ? undefined
          : yield* repositoryKeyThere(scope, environmentId, params.projectId);
      const parentKey =
        targetKey === undefined || cwd === undefined
          ? undefined
          : (yield* repositoryIdentities.resolve(cwd))?.canonicalKey;
      const base = targetKey !== undefined && targetKey !== parentKey ? undefined : commitBase;
      if (base === undefined) {
        const target =
          params.projectId === undefined
            ? undefined
            : yield* forwarding.call(scope, ProjectToolkit.tools.t3_project_read, environmentId, {
                projectId: params.projectId,
              });
        if (target?.defaultBaseRef === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Isolation "worktree" has no base: project "${target?.title ?? params.projectId}" there has no default branch, and this thread's checkout has no commit of its repository. Pass baseRef (a branch, tag, or commit in that project), or use isolation "shared".`,
          });
        return { launched: yield* launchOn(target.defaultBaseRef) };
      }
      const launchFrom = (baseRef: string, startFromOrigin: boolean) =>
        forwarding.call(scope, ProjectToolkit.tools.t3_thread_launch, environmentId, {
          ...params,
          message: `${params.message ?? ""}${COMMIT_ONLY}`,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin },
        });
      const { commit, fetchable } = base;
      return yield* launchFrom(commit, false).pipe(
        Effect.map((launched) => ({ launched, worktreeBase: commit })),
        Effect.catchIf(
          (error) => error.code === "invalid_request",
          (error) =>
            fetchable === null
              ? Effect.fail(
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: `Commit ${commit} is not there and is on no remote branch it can fetch. Push it, or omit isolation. Uncommitted edits never go with the task. (${error.message})`,
                  }),
                )
              : launchFrom(fetchable, true).pipe(
                  Effect.map((launched) => ({ launched, worktreeBase: commit })),
                ),
        ),
      );
    },
  );

  const bringBack = Effect.fn("RemoteWorktreeTask.bringBack")(function* (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild & { readonly worktreeBase: string },
    parent: ParentCheckout,
    suffix: string,
  ) {
    const cwd = yield* checkoutOf(parent);
    const branches =
      cwd === undefined
        ? []
        : yield* transfer.remoteBranchesContaining(cwd, remote.worktreeBase).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                }),
            ),
          );
    let failureMessage = "";
    const exported = yield* forwarding
      .call(scope, WorktreeToolkit.tools.t3_worktree_export, remote.environmentId, {
        threadId: remote.threadId,
        bases: [remote.worktreeBase, ...branches.map(({ commit }) => commit)],
        branches: branches.map(({ name }) => name),
      })
      .pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) =>
            error.code === "invalid_request" ||
            error.code === "thread_not_found" ||
            error.code === "thread_deleted" ||
            error.code === "capability_denied" ||
            error.code === "runtime_mode_escalation_denied" ||
            error.code === "interaction_mode_escalation_denied",
          (error) => {
            failureMessage = ` ${error.message}`;
            return Effect.succeedNone;
          },
        ),
      );
    if (Option.isNone(exported))
      return `Its work stays in its worktree in ${remote.label}; it could not be brought back.${failureMessage}`;
    const out = exported.value;
    const there = `branch ${out.branch} in ${out.worktreePath} in ${remote.label}`;
    const left = `${out.uncommitted ? ` Uncommitted changes stay in ${out.worktreePath} there.` : ""}${out.note === undefined ? "" : ` ${out.note}`}`;
    if (out.commitCount === 0) return `It made no commits on ${there}.${left}`;
    const bundle = out.bundle;
    const local =
      bundle === null || cwd === undefined
        ? undefined
        : yield* transfer.importBranch({ cwd, exported: { ...out, bundle }, suffix }).pipe(
            Effect.catch((error) =>
              error.retryable
                ? Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    }),
                  )
                : Effect.sync(() => {
                    failureMessage = ` ${error.message}`;
                  }),
            ),
          );
    if (local === undefined)
      return `Its ${out.commitCount} commit${out.commitCount === 1 ? "" : "s"} are on ${there}; they could not be brought back.${failureMessage}${left}`;
    return `Branch ${local} here has its ${out.commitCount} commit${out.commitCount === 1 ? "" : "s"} (head ${out.headCommit.slice(0, 12)}) on ${out.baseCommit.slice(0, 12)}, from ${there}.${left}\n${out.diffStat}`;
  });

  const withWork: RemoteWorktreeTask["Service"]["withWork"] = (
    scope,
    remote,
    parent,
    taskId,
    reply,
  ) => {
    const { worktreeBase } = remote;
    if (worktreeBase === undefined) return Effect.succeed(reply);
    return bringBack(scope, { ...remote, worktreeBase }, parent, taskId.slice(-8)).pipe(
      Effect.map((work) => `${reply}\n\n${work}`),
    );
  };

  return RemoteWorktreeTask.of({ launch, withWork });
});

export const layer = Layer.effect(RemoteWorktreeTask, make).pipe(
  Layer.provide(WorktreeTransfer.layer),
);
