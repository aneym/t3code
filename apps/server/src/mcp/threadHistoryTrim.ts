import type { OrchestrationV2AppThread, OrchestratorMcpThreadDetail } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function threadHistoryTrim(
  thread: Pick<OrchestrationV2AppThread, "historyTrimmedAt">,
): Pick<OrchestratorMcpThreadDetail, "historyTrimmedAt"> {
  return thread.historyTrimmedAt == null
    ? {}
    : { historyTrimmedAt: DateTime.formatIso(thread.historyTrimmedAt) };
}
