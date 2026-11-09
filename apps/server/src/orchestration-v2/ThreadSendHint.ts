import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export function threadSendHint(
  run: Pick<OrchestrationV2Run, "queueHoldReason" | "queueHeldByThreadId">,
  thread: OrchestrationV2ThreadProjection["thread"],
): string {
  switch (run.queueHoldReason) {
    case "stop":
      return run.queueHeldByThreadId === undefined
        ? "Waits for a resume of this thread; mode auto starts now."
        : `Waits for a resume of ${run.queueHeldByThreadId}, whose Stop held it, or of this thread; mode auto starts now.`;
    case "restart":
      return "Waits for server restart recovery; mode auto starts now.";
    case "blocked":
      return thread.createdBy === "agent"
        ? "Waits for the blocking condition to clear and a run to complete; a transient provider failure also releases when the provider recovers; mode auto starts now."
        : "Waits for the blocking condition to clear and a run to complete; mode auto starts now.";
    case undefined:
      return thread.createdBy === "agent"
        ? "Releases when a run ends on this thread; mode auto starts now."
        : "Waits for the user to resume; mode auto starts now.";
  }
}
