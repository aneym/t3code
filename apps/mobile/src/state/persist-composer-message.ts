import { enqueueThreadOutboxMessage } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { setThreadComposerError } from "./thread-composer-error";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  scheduleUnusedComposerAttachmentCleanup,
  type ComposerDraft,
} from "./use-composer-drafts";

export async function persistComposerMessage(
  threadKey: string,
  draft: ComposerDraft,
  message: QueuedThreadMessage,
) {
  try {
    await enqueueThreadOutboxMessage(message);
    const current = getComposerDraftSnapshot(threadKey);
    if (
      current.text === draft.text &&
      JSON.stringify(current.context) === JSON.stringify(draft.context) &&
      current.attachments.length === draft.attachments.length &&
      current.attachments.every(
        (attachment, index) => attachment.id === draft.attachments[index]?.id,
      )
    ) {
      clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
    }
  } catch (error) {
    setThreadComposerError(
      threadKey,
      error instanceof Error ? error.message : "Failed to save the queued message.",
    );
    return null;
  }
  scheduleUnusedComposerAttachmentCleanup(draft.attachments);
  return message.messageId;
}
