import type { LegendListRef } from "@legendapp/list/react";
import { type RefObject, useLayoutEffect } from "react";

import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";
import { postToEmbedHost } from "./embedHost";
import { EMBED_REVEALED_MESSAGE, type EmbedRevealRequest } from "./embedProtocol";

const MISSING_AFTER_MS = 1500;
const GIVE_UP_AFTER_MS = 5000;
const VIEW_POSITION = 0.3;
const VIEW_SHARE = 0.7;

let target: RefObject<LegendListRef | null> | null = null;
let settle: ((found: boolean) => void) | null = null;

export function useEmbedRevealTarget(
  listRef: RefObject<LegendListRef | null>,
  enabled: boolean,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands host reveal requests the mounted LegendList, which only draws rows near the viewport
  useLayoutEffect(() => {
    if (!enabled) return;
    target = listRef;
    return () => {
      if (target === listRef) target = null;
    };
  }, [enabled, listRef]);
}

function rowIndex(rows: ReadonlyArray<MessagesTimelineRow>, id: string): number {
  return rows.findIndex(
    (row) =>
      row.id === id ||
      ((row.kind === "message" || row.kind === "assistant-meta") && row.message.id === id),
  );
}

function drawnRow(node: HTMLElement, id: string): HTMLElement | null {
  const value = CSS.escape(id);
  return node.querySelector<HTMLElement>(
    `[data-timeline-row-id="${value}"], [data-message-id="${value}"]`,
  );
}

function placed(row: HTMLElement, node: HTMLElement, strict: boolean): boolean {
  const box = row.getBoundingClientRect();
  const view = node.getBoundingClientRect();
  const limit = strict ? view.top + view.height * VIEW_SHARE : view.bottom;
  return box.height > 0 && box.bottom > view.top && box.top < limit;
}

export function revealEmbedRow(request: EmbedRevealRequest): void {
  settle?.(false);
  const started = performance.now();
  let frame = 0;
  let scrolledTo = -1;
  let nudged = false;
  const done = (found: boolean) => {
    cancelAnimationFrame(frame);
    if (settle === done) settle = null;
    postToEmbedHost({ type: EMBED_REVEALED_MESSAGE, ...request, found });
  };
  settle = done;
  const step = (now: number) => {
    const list = target?.current ?? null;
    const node: HTMLElement | null = list?.getScrollableNode() ?? null;
    const rows: ReadonlyArray<MessagesTimelineRow> = list?.getState().data ?? [];
    const index = rowIndex(rows, request.id);
    const drawn = node === null ? null : drawnRow(node, request.id);
    const waited = now - started;
    if (list !== null && index >= 0 && index !== scrolledTo) {
      scrolledTo = index;
      void list.scrollToIndex({ index, animated: false, viewPosition: VIEW_POSITION });
    } else if (drawn !== null && node !== null && placed(drawn, node, true)) {
      return done(true);
    } else if (drawn !== null && index < 0 && !nudged) {
      nudged = true;
      drawn.scrollIntoView({ block: "center" });
    }
    if (waited > GIVE_UP_AFTER_MS || (index < 0 && drawn === null && waited > MISSING_AFTER_MS)) {
      return done(drawn !== null && node !== null && placed(drawn, node, false));
    }
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}
