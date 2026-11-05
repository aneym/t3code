import type { OrchestrationV2Command } from "@t3tools/contracts";

type DelegatedTaskRequest = Extract<
  OrchestrationV2Command,
  { readonly type: "delegated_task.request" }
>;

export const delegatedChildWorkspace = ({ projectId, workspaceStrategy }: DelegatedTaskRequest) =>
  projectId === undefined && workspaceStrategy === undefined
    ? {}
    : {
        ...(projectId === undefined ? {} : { projectId }),
        branch: null,
        worktreePath: null,
      };
