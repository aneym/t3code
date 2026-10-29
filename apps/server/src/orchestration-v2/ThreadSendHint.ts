import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export function threadSendHint(
  reason: OrchestrationV2Run["queueHoldReason"],
  thread: OrchestrationV2ThreadProjection["thread"],
): string {
  switch (reason) {
    case "stop":
      return thread.createdBy === "agent"
        ? "Releases after the next completed run on this thread; send with mode auto to start now."
        : "Waits for the user to resume; mode auto starts now.";
    case "restart":
      return "Waits for server restart recovery; mode auto starts now.";
    case "blocked":
      return "Waits for the blocking condition to clear and a run to complete; mode auto starts now.";
    case undefined:
      return thread.createdBy === "agent"
        ? "Releases when a run ends on this thread; mode auto starts now."
        : "Waits for the user to resume; mode auto starts now.";
  }
}
