import type { AttachmentUploadState } from "../lib/attachmentUploadState";
import { useAttachmentUploadStore } from "../lib/attachmentUploadQueue";
import { openEmbedSendId, postEmbedSendMark } from "./embedSendMarks";

export function watchEmbedUploads(thread: string): () => void {
  let busy = false;
  const report = (uploads: Readonly<Record<string, AttachmentUploadState>>) => {
    const next = Object.values(uploads).some((upload) => upload.status === "uploading");
    if (next === busy) return;
    busy = next;
    postEmbedSendMark(thread, {
      mark: "uploads",
      messageId: openEmbedSendId(thread),
      state: next ? "busy" : "idle",
    });
  };
  report(useAttachmentUploadStore.getState().uploadsByImageId);
  return useAttachmentUploadStore.subscribe((state) => report(state.uploadsByImageId));
}
