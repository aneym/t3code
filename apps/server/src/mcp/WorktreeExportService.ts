import {
  CommandId,
  OrchestratorMcpFailure,
  type WorktreeMcpExportInput,
  type WorktreeMcpExportResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorktreeTransfer from "../peer/WorktreeTransfer.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { dispatchFailure, readThread } from "./threadAccess.ts";

export class WorktreeExportService extends Context.Service<
  WorktreeExportService,
  {
    readonly exportBranch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: WorktreeMcpExportInput,
    ) => Effect.Effect<
      WorktreeMcpExportResult,
      OrchestratorMcpFailure,
      | GitVcsDriver.GitVcsDriver
      | FileSystem.FileSystem
      | ThreadManagementService.ThreadManagementService
    >;
  }
>()("t3/mcp/WorktreeExportService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const exportBranch: WorktreeExportService["Service"]["exportBranch"] = Effect.fn(
    "WorktreeExportService.exportBranch",
  )(function* (scope: McpInvocationContext.McpInvocationScope, input: WorktreeMcpExportInput) {
    if (!scope.capabilities.has("worktree"))
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential cannot inspect worktrees.",
      });
    if (scope.client?.linked !== true)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Only a linked environment's delegate_task exports a worktree.",
      });
    const {
      projection: { thread },
    } = yield* readThread(input.threadId).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    if (thread.worktreePath === null || thread.branch === null)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The thread has no worktree branch.",
      });
    const { worktreePath, branch } = thread;
    const exported = yield* WorktreeTransfer.WorktreeTransfer.pipe(
      Effect.flatMap((transfer) =>
        transfer.exportBranch({
          worktreePath,
          bases: input.bases,
          branches: input.branches,
        }),
      ),
      Effect.provide(WorktreeTransfer.layer),
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.retryable ? "orchestration_error" : "invalid_request",
            message: error.message,
          }),
      ),
    );
    if (exported.branch !== thread.branch) {
      const note = yield* threadManagement
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(
            `worktree-export:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          ),
          threadId: thread.id,
          branch: exported.branch,
          expectedBranch: branch,
          expectedWorktreePath: worktreePath,
        })
        .pipe(
          Effect.as(undefined),
          Effect.catch((error) =>
            Effect.succeed(
              `The branch was exported, but thread metadata was not updated: ${dispatchFailure(error).message}`,
            ),
          ),
        );
      if (note !== undefined) return { ...exported, note };
    }
    return exported;
  });

  return WorktreeExportService.of({ exportBranch });
});

export const layer = Layer.effect(WorktreeExportService, make);
