import type { QueuedThreadRun } from "@t3tools/client-runtime/state/thread-workflows";
import type { ChatAttachment as ContractChatAttachment } from "@t3tools/contracts";
import { isImageAttachment, type ChatMessage } from "../../types";

export interface QueuedRowThumbnail {
  readonly key: string;
  readonly name: string;
  readonly url: string | null;
}

export function queuedRunRows(
  queued: ReadonlyArray<QueuedThreadRun>,
  optimisticQueued: ReadonlyArray<Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">>,
  queuedImageUrlById: ReadonlyMap<string, string>,
) {
  return [
    ...queued.map(
      ({ run, text, attachments, context, message, isBackgroundResult }, serverIndex) => ({
        key: run.id,
        message,
        runId: run.id,
        messageId: run.userMessageId,
        serverIndex,
        text,
        editable: context?.guest === undefined && !isBackgroundResult,
        isBackgroundResult,
        attachments,
        thumbnails: attachments
          .filter((attachment) => attachment.type === "image")
          .map<QueuedRowThumbnail>((attachment) => ({
            key: attachment.id,
            name: attachment.name,
            url: queuedImageUrlById.get(attachment.id) ?? null,
          })),
        pending: false,
      }),
    ),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      message: undefined,
      runId: null,
      messageId: null,
      serverIndex: null,
      text: message.text,
      editable: true,
      isBackgroundResult: false,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? [])
        .filter(isImageAttachment)
        .map<QueuedRowThumbnail>((attachment) => ({
          key: attachment.id,
          name: attachment.name,
          url: attachment.previewUrl ?? null,
        })),
      pending: true,
    })),
  ];
}
