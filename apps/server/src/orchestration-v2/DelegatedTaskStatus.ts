import type { OrchestrationV2Run, OrchestrationV2Subagent } from "@t3tools/contracts";

export function delegatedTaskTerminalStatus(
  status: OrchestrationV2Run["status"],
): OrchestrationV2Subagent["status"] | null {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    case "rolled_back":
      return "cancelled";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return null;
  }
}

export function isTerminalDelegatedTaskStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}
