import {
  EMBED_CAPABILITIES,
  EMBED_READY_MESSAGE,
  EMBED_ROUTE_REFUSED_MESSAGE,
  type EmbedPaintSource,
  type EmbedReadyMessage,
} from "@t3tools/contracts";

import { postToEmbedHost } from "./embedHost";

const DRAWN_ATTRIBUTE = "data-timeline-thread";

export type EmbedReadyWatch = {
  readonly navigating: () => void;
  readonly report: (threadId: string, key: string | null, from: EmbedPaintSource) => void;
  readonly refuse: (threadId: string) => void;
  readonly stop: () => void;
};

let painted: string | null = null;
let refusedThread: string | null = null;

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

function postRefusal(threadId: string): boolean {
  return postToEmbedHost({
    type: EMBED_ROUTE_REFUSED_MESSAGE,
    thread: threadId,
    reason: "not-visible",
  });
}

export function repeatEmbedAnswer(threadId: string): boolean {
  if (painted === threadId) return postReady(threadId, "memory");
  if (refusedThread === threadId) return postRefusal(threadId);
  return false;
}

export function createEmbedReadyWatch(): EmbedReadyWatch {
  let reported: string | null = null;
  let waiting: {
    readonly threadId: string;
    readonly selector: string;
    readonly from: EmbedPaintSource;
  } | null = null;
  const check = () => {
    if (waiting !== null && document.querySelector(waiting.selector) !== null)
      send(waiting.threadId, waiting.from);
  };
  const observer = new MutationObserver(check);
  const stop = () => {
    observer.disconnect();
    waiting = null;
  };
  const send = (threadId: string, from: EmbedPaintSource) => {
    stop();
    if (postReady(threadId, from)) reported = threadId;
  };
  return {
    navigating: () => {
      stop();
      reported = null;
      refusedThread = null;
      painted = null;
    },
    report: (threadId, key, from) => {
      stop();
      if (reported === threadId) return;
      if (key === null) return send(threadId, from);
      waiting = { threadId, selector: `[${DRAWN_ATTRIBUTE}="${CSS.escape(key)}"]`, from };
      check();
      if (waiting === null) return;
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributeFilter: [DRAWN_ATTRIBUTE],
      });
    },
    refuse: (threadId) => {
      stop();
      if (refusedThread === threadId) return;
      if (postRefusal(threadId)) refusedThread = threadId;
    },
    stop,
  };
}
