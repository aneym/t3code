import { postToEmbedHost } from "./embedHost";
import { EMBED_READY_MESSAGE } from "./embedProtocol";

const ROW = "[data-timeline-row-kind]";
const NO_ROWS_GRACE_MS = 1000;

export type EmbedReadyWatch = {
  readonly navigating: () => void;
  readonly report: (threadId: string, settled: boolean, drawsRows: boolean) => void;
  readonly stop: () => void;
};

export function createEmbedReadyWatch(): EmbedReadyWatch {
  let before: ReadonlySet<Element> = new Set();
  let reported: string | null = null;
  let waiting: string | null = null;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const rowsDrawn = () => {
    for (const row of document.querySelectorAll(ROW)) if (!before.has(row)) return true;
    return false;
  };
  const observer = new MutationObserver(() => {
    if (waiting !== null && rowsDrawn()) send(waiting);
  });
  const stop = () => {
    observer.disconnect();
    waiting = null;
    clearTimeout(grace);
  };
  const send = (threadId: string) => {
    stop();
    if (postToEmbedHost({ type: EMBED_READY_MESSAGE, threadId })) reported = threadId;
  };
  return {
    navigating: () => {
      stop();
      before = new Set(document.querySelectorAll(ROW));
      reported = null;
    },
    report: (threadId, settled, drawsRows) => {
      stop();
      if (!settled || reported === threadId) return;
      if (!drawsRows || rowsDrawn()) return send(threadId);
      waiting = threadId;
      observer.observe(document.body, { childList: true, subtree: true });
      grace = setTimeout(() => send(threadId), NO_ROWS_GRACE_MS);
    },
    stop,
  };
}
