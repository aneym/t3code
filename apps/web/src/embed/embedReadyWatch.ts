import {
  EMBED_CAPABILITIES,
  EMBED_READY_MESSAGE,
  EMBED_ROUTE_REFUSED_MESSAGE,
  type EmbedPaintSource,
  type EmbedReadyMessage,
} from "@t3tools/contracts";

import { postToEmbedHost } from "./embedHost";
import { markEmbedRouteStep, takeEmbedRouteTimings } from "./embedRouteTimings";

const ROW = "[data-timeline-row-kind]";
const EMPTY = "[data-timeline-empty]";
const DRAWN = `${ROW},${EMPTY},[data-timeline-root]`;
const SHOWN = `${DRAWN},[data-embed-view]`;
const NO_ROWS_GRACE_MS = 1000;

export type EmbedDraws = "rows" | "view" | "nothing";

export type EmbedReadyWatch = {
  readonly navigating: () => void;
  readonly report: (
    threadId: string,
    settled: boolean,
    draws: EmbedDraws,
    from: EmbedPaintSource,
    parentThreadId?: string,
  ) => void;
  readonly refuse: (threadId: string) => void;
  readonly stop: () => void;
};

let painted: { readonly threadId: string; readonly parentThreadId?: string } | null = null;

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

export function repeatEmbedReady(threadId: string): boolean {
  return painted?.threadId === threadId && postReady(threadId, "memory", painted.parentThreadId);
}

export function createEmbedReadyWatch(): EmbedReadyWatch {
  let before: ReadonlySet<Element> = new Set();
  let reported: string | null = null;
  let refused: string | null = null;
  let waiting: {
    readonly threadId: string;
    readonly from: EmbedPaintSource;
    readonly parentThreadId: string | undefined;
  } | null = null;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let graceOver = false;
  const fresh = (selector: string) => {
    for (const element of document.querySelectorAll(selector))
      if (!before.has(element)) return true;
    return false;
  };
  let draws: EmbedDraws = "nothing";
  const drawn = () => {
    if (draws === "nothing") return true;
    if (graceOver) return document.querySelector(SHOWN) !== null;
    return fresh(draws === "rows" ? ROW : DRAWN);
  };
  const check = () => {
    if (waiting !== null && drawn()) send(waiting.threadId, waiting.from, waiting.parentThreadId);
  };
  const observer = new MutationObserver(check);
  const stop = () => {
    observer.disconnect();
    waiting = null;
    clearTimeout(grace);
  };
  const send = (threadId: string, from: EmbedPaintSource, parentThreadId?: string) => {
    stop();
    if (postReady(threadId, from, parentThreadId)) reported = threadId;
  };
  return {
    navigating: () => {
      stop();
      before = new Set(document.querySelectorAll(DRAWN));
      reported = null;
      refused = null;
      painted = null;
    },
    report: (threadId, settled, next, from, parentThreadId) => {
      stop();
      if (!settled || reported === threadId) return;
      draws = next;
      graceOver = false;
      waiting = { threadId, from, parentThreadId };
      check();
      if (waiting === null) return;
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributeFilter: ["data-timeline-row-kind", "data-timeline-empty", "data-timeline-root"],
      });
      grace = setTimeout(() => {
        graceOver = true;
        check();
      }, NO_ROWS_GRACE_MS);
    },
    refuse: (threadId) => {
      stop();
      if (refused === threadId) return;
      if (
        postToEmbedHost({
          type: EMBED_ROUTE_REFUSED_MESSAGE,
          thread: threadId,
          reason: "not-visible",
        })
      )
        refused = threadId;
    },
    stop,
  };
}
