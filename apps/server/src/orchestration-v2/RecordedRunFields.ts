import type { OrchestrationV2Run } from "@t3tools/contracts";

export function preserveRunRecordedFields(
  current: OrchestrationV2Run | undefined,
  next: OrchestrationV2Run,
): OrchestrationV2Run {
  if (current === undefined) return next;
  return {
    ...next,
    ...(next.retainBlockedCompletionHolds === undefined &&
    current.retainBlockedCompletionHolds !== undefined
      ? { retainBlockedCompletionHolds: current.retainBlockedCompletionHolds }
      : {}),
    ...(next.delegatedCompletion === undefined && current.delegatedCompletion !== undefined
      ? { delegatedCompletion: current.delegatedCompletion }
      : {}),
    ...(next.restartCancelledBackgroundWork === undefined &&
    current.restartCancelledBackgroundWork !== undefined
      ? { restartCancelledBackgroundWork: current.restartCancelledBackgroundWork }
      : {}),
  };
}
