import {
  EMBED_CAPABILITIES,
  EMBED_READY_MESSAGE,
  EMBED_ROUTE_REFUSED_MESSAGE,
  type EmbedPaintSource,
  type EmbedReadyMessage,
} from "@t3tools/contracts";

import { postToEmbedHost } from "./embedHost";
import { markEmbedRouteStep, takeEmbedRouteTimings } from "./embedRouteTimings";

const DRAWN_ATTRIBUTE = "data-timeline-thread";

export type EmbedReadyWatch = {
  readonly navigating: () => void;
  readonly report: (
    threadId: string,
    key: string | null,
    from: EmbedPaintSource,
    parentThreadId?: string,
  ) => void;
  readonly refuse: (threadId: string) => void;
  readonly stop: () => void;
};

let painted: { readonly threadId: string; readonly parentThreadId?: string } | null = null;
let refusedThread: string | null = null;

function postReady(threadId: string, from: EmbedPaintSource, parentThreadId?: string): boolean {
  markEmbedRouteStep(threadId, "drawn");
  const timings = takeEmbedRouteTimings(threadId);
  const message: EmbedReadyMessage = {
    type: EMBED_READY_MESSAGE,
    threadId,
    from,
    capabilities: EMBED_CAPABILITIES,
    ...(timings === undefined ? {} : { timings }),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
  };
  if (!postToEmbedHost(message)) return false;
  painted = parentThreadId === undefined ? { threadId } : { threadId, parentThreadId };
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
  if (painted?.threadId === threadId) return postReady(threadId, "memory", painted.parentThreadId);
  if (refusedThread === threadId) return postRefusal(threadId);
  return false;
}

export function createEmbedReadyWatch(): EmbedReadyWatch {
  let reported: string | null = null;
  let waiting: {
    readonly threadId: string;
    readonly selector: string;
    readonly from: EmbedPaintSource;
    readonly parentThreadId: string | undefined;
  } | null = null;
  const check = () => {
    if (waiting !== null && document.querySelector(waiting.selector) !== null)
      send(waiting.threadId, waiting.from, waiting.parentThreadId);
  };
  const observer = new MutationObserver(check);
  const stop = () => {
    observer.disconnect();
    waiting = null;
  };
  const send = (threadId: string, from: EmbedPaintSource, parentThreadId?: string) => {
    stop();
    if (postReady(threadId, from, parentThreadId)) reported = threadId;
  };
  return {
    navigating: () => {
      stop();
      reported = null;
      refusedThread = null;
      painted = null;
    },
    report: (threadId, key, from, parentThreadId) => {
      stop();
      if (reported === threadId) return;
      if (key === null) return send(threadId, from, parentThreadId);
      waiting = {
        threadId,
        selector: `[${DRAWN_ATTRIBUTE}="${CSS.escape(key)}"]`,
        from,
        parentThreadId,
      };
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
