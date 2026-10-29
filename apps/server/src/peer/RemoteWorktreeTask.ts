import {
  type EnvironmentId,
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
import * as PeerForwarding from "./PeerForwarding.ts";
import * as WorktreeTransfer from "./WorktreeTransfer.ts";

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;
type LaunchParams = Tool.Parameters<typeof ProjectToolkit.tools.t3_thread_launch>;
type LaunchResult = Tool.Success<typeof ProjectToolkit.tools.t3_thread_launch>;
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
      worktreeOf: ParentCheckout | undefined,
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

  const checkoutOf = (parent: ParentCheckout) =>
    parent.worktreePath === null
      ? projects.getById(parent.projectId).pipe(
          Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.succeed(parent.worktreePath);

  const launch: RemoteWorktreeTask["Service"]["launch"] = Effect.fn("RemoteWorktreeTask.launch")(
    function* (scope, environmentId, worktreeOf, params) {
      if (worktreeOf === undefined) {
        const launched = yield* forwarding.call(
          scope,
          ProjectToolkit.tools.t3_thread_launch,
          environmentId,
          params,
        );
        return { launched };
      }
      const cwd = yield* checkoutOf(worktreeOf);
      const base =
        cwd === undefined
          ? undefined
          : yield* transfer.resolveBase(cwd).pipe(Effect.orElseSucceed(() => undefined));
      if (base === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: 'Isolation "worktree" needs this thread\'s checkout to have a commit.',
        });
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
                  Effect.map((launched) => ({ launched, worktreeBase: fetchable })),
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
    const exported = yield* forwarding
      .call(scope, WorktreeToolkit.tools.t3_worktree_export, remote.environmentId, {
        threadId: remote.threadId,
        base: remote.worktreeBase,
      })
      .pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) =>
            error.code === "invalid_request" ||
            error.code === "thread_not_found" ||
            error.code === "capability_denied",
          () => Effect.succeedNone,
        ),
      );
    if (Option.isNone(exported))
      return `Its work stays in its worktree in ${remote.label}; it could not be brought back.`;
    const out = exported.value;
    const there = `branch ${out.branch} in ${out.worktreePath} in ${remote.label}`;
    const left = out.uncommitted ? ` Uncommitted changes stay in ${out.worktreePath} there.` : "";
    if (out.commitCount === 0) return `It made no commits on ${there}.${left}`;
    const cwd = yield* checkoutOf(parent);
    const bundle = out.bundle;
    const local =
      bundle === null || cwd === undefined
        ? undefined
        : yield* transfer
            .importBranch({ cwd, exported: { ...out, bundle }, suffix })
            .pipe(Effect.orElseSucceed(() => undefined));
    if (local === undefined)
      return `Its ${out.commitCount} commit${out.commitCount === 1 ? "" : "s"} are on ${there}; they could not be brought back.${left}`;
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
