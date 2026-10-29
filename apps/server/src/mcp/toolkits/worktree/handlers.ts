import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as WorktreeTransfer from "../../../peer/WorktreeTransfer.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import { WorktreeToolkit } from "./tools.ts";

const requireWorktreeCapability = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((context) =>
    context.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This credential cannot inspect worktrees.",
          }),
        ),
  ),
);

const handlers = {
  t3_worktree_export: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireWorktreeCapability;
      if ((yield* McpInvocationContext.McpInvocationContext).client?.linked !== true)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a linked environment's delegate_task exports a worktree.",
        });
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      if (thread.worktreePath === null || thread.branch === null)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The thread has no worktree branch.",
        });
      const { worktreePath, branch } = thread;
      return yield* WorktreeTransfer.WorktreeTransfer.pipe(
        Effect.flatMap((transfer) =>
          transfer.exportBranch({ worktreePath, branch, base: input.base }),
        ),
        Effect.provide(WorktreeTransfer.layer),
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
        ),
      );
    }),
  ),
  t3_worktree_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireWorktreeCapability;
      const { threadId, ...refs } = input;
      const {
        projection: { thread },
      } = yield* readThread(threadId);
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      const git = yield* GitWorkflow.GitWorkflowService;
      return yield* git
        .listRefs({ ...refs, cwd: thread.worktreePath ?? project.value.workspaceRoot })
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_worktree_handoff: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.handoff(scope, input);
    }),
  ),
  t3_worktree_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* WorktreeMcpService.WorktreeMcpService;
      return yield* service.status(scope);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof WorktreeToolkit.tools>;

export const layer = McpToolAccess.toLayer(WorktreeToolkit, handlers);
