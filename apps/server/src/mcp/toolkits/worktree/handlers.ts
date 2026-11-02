import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as WorktreeExportService from "../../WorktreeExportService.ts";
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
  t3_worktree_export: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* WorktreeExportService.WorktreeExportService;
        return yield* service.exportBranch(scope, input);
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

export const layerServices = Layer.mergeAll(WorktreeMcpService.layer, WorktreeExportService.layer);
