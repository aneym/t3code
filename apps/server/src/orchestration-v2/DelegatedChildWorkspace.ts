import type { OrchestrationV2AppThread, OrchestrationV2Command } from "@t3tools/contracts";

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
        ...thread,
        ...(projectId === undefined ? {} : { projectId }),
        branch: null,
        worktreePath: null,
      };
