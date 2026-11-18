import {
  EMBED_CAPABILITIES,
  EMBED_READY_MESSAGE,
  type EmbedPaintSource,
  type EmbedReadyMessage,
} from "@t3tools/contracts";

import { postToEmbedHost } from "./embedHost";

const ROW = "[data-timeline-row-kind]";
const NO_ROWS_GRACE_MS = 1000;

export type EmbedReadyWatch = {
  readonly navigating: () => void;
  readonly report: (
    threadId: string,
    settled: boolean,
    drawsRows: boolean,
    from: EmbedPaintSource,
  ) => void;
  readonly stop: () => void;
};

let painted: string | null = null;

function postReady(threadId: string, from: EmbedPaintSource): boolean {
  const message: EmbedReadyMessage = {
    type: EMBED_READY_MESSAGE,
    threadId,
    from,
    capabilities: EMBED_CAPABILITIES,
  };
  if (!postToEmbedHost(message)) return false;
  painted = threadId;
  return true;
}

export function repeatEmbedReady(threadId: string): boolean {
  return painted === threadId && postReady(threadId, "memory");
}

export function createEmbedReadyWatch(): EmbedReadyWatch {
  let before: ReadonlySet<Element> = new Set();
  let reported: string | null = null;
  let waiting: { readonly threadId: string; readonly from: EmbedPaintSource } | null = null;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const rowsDrawn = () => {
    for (const row of document.querySelectorAll(ROW)) if (!before.has(row)) return true;
    return false;
  };
  const observer = new MutationObserver(() => {
    if (waiting !== null && rowsDrawn()) send(waiting.threadId, waiting.from);
  });
  const stop = () => {
    observer.disconnect();
    waiting = null;
    clearTimeout(grace);
  };
  const send = (threadId: string, from: EmbedPaintSource) => {
    stop();
    if (postReady(threadId, from)) reported = threadId;
  };
  return {
    navigating: () => {
      stop();
      before = new Set(document.querySelectorAll(ROW));
      reported = null;
      painted = null;
    },
    report: (threadId, settled, drawsRows, from) => {
      stop();
      if (!settled || reported === threadId) return;
      if (!drawsRows || rowsDrawn()) return send(threadId, from);
      waiting = { threadId, from };
      observer.observe(document.body, { childList: true, subtree: true });
      grace = setTimeout(() => send(threadId, from), NO_ROWS_GRACE_MS);
    },
    stop,
  };
}
