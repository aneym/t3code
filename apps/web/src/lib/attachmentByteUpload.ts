import type { AttachmentByteUpload } from "@t3tools/client-runtime/state/attachments";

const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const RETRY_DELAY_MS = 1_000;

export function uploadAttachmentBytes(input: {
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly onProgress: (progress: number) => void;
}): AttachmentByteUpload {
  let current: XMLHttpRequest | null = null;
  let stopWaiting: (() => void) | null = null;
  let aborted = false;
  let retryable = false;
  const attempt = () =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      current = xhr;
      const fail = (message: string, retry: boolean) => {
        retryable = retry;
        reject(new Error(message));
      };
      xhr.open("POST", input.url, true);
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.setRequestHeader("Content-Type", input.mimeType);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) {
          input.onProgress(event.loaded / event.total);
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        if (xhr.status >= 500) return fail("Upload failed: the server had a problem.", true);
        fail("Upload failed: the server refused this file.", false);
      });
      xhr.addEventListener("error", () => fail("Upload failed: the connection dropped.", true));
      xhr.addEventListener("timeout", () => fail("Upload failed: it took too long.", false));
      xhr.addEventListener("abort", () => fail("Upload cancelled", false));
      xhr.send(input.file);
    });
  const waitBeforeRetry = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, RETRY_DELAY_MS);
      stopWaiting = () => {
        clearTimeout(timer);
        reject(new Error("Upload cancelled"));
      };
    });
  const done = attempt().catch(async (error: Error) => {
    if (aborted || !retryable) throw error;
    console.warn(`[attachment-upload] retrying once: ${error.message}`);
    await waitBeforeRetry();
    stopWaiting = null;
    return attempt();
  });
  return {
    done,
    abort: () => {
      aborted = true;
      stopWaiting?.();
      current?.abort();
    },
  };
}
