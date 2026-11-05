import type { OrchestrationV2AppThread, OrchestrationV2Command } from "@t3tools/contracts";
import * as Struct from "effect/Struct";

type DelegatedTaskRequest = Extract<
  OrchestrationV2Command,
  { readonly type: "delegated_task.request" }
>;

export const delegatedChildWorkspace = (
  thread: OrchestrationV2AppThread,
  { projectId, workspaceStrategy }: DelegatedTaskRequest,
): OrchestrationV2AppThread =>
  projectId === undefined && workspaceStrategy === undefined
    ? thread
    : {
        ...Struct.omit(thread, ["cwd"]),
        ...(projectId === undefined ? {} : { projectId }),
        branch: null,
        worktreePath: null,
      };
