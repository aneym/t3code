import type {
  QueuedThreadRun,
  ThreadQueueWorkflowState,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { RunId } from "@t3tools/contracts";
import { resolveThreadQueueRowControls } from "./threadQueueControlPresentation";

export function threadQueueEntryControls(
  entry: QueuedThreadRun,
  input: {
    readonly busyRunId: RunId | null;
    readonly workflow: ThreadQueueWorkflowState | null | undefined;
    readonly editBlockedReason: string | null;
    readonly editingRunId: RunId | undefined;
  },
) {
  return resolveThreadQueueRowControls({
    busy: input.busyRunId !== null,
    canPromoteToSteer: input.workflow?.canPromoteToSteer ?? false,
    canSendNow: input.workflow?.canSendNow ?? false,
    editBlocked: input.editBlockedReason !== null,
    isEditing: input.editingRunId === entry.run.id,
    isGuestMessage: entry.context?.guest !== undefined,
    isBackgroundResult: entry.isBackgroundResult,
    text: entry.text,
  });
}
