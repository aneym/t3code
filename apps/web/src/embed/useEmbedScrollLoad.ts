import { useEffect, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { inEmbedPage } from "./embedProtocol";

const GESTURE_WINDOW_MS = 1_500;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const GESTURES = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

function scrollsByKey(event: KeyboardEvent): boolean {
  const target = event.target;
  const editable =
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null);
  return SCROLL_KEYS.has(event.key) && !editable;
}

function grabsScrollbar(event: PointerEvent, node: HTMLElement): boolean {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    target !== node &&
    target.contains(node) &&
    target.scrollHeight > target.clientHeight
  );
}

export function useEmbedScrollLoad(enabled: boolean, onLoad: () => void) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const load = useStableCallback(onLoad);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pages earlier turns in the embed when the person's own scroll brings the control into view
  useEffect(() => {
    if (!enabled || node === null || !inEmbedPage()) return;
    let gestureAt = Number.NEGATIVE_INFINITY;
    let armed = false;
    const noteGesture = (event: Event) => {
      if (event instanceof KeyboardEvent && !scrollsByKey(event)) return;
      if (event instanceof PointerEvent && !grabsScrollbar(event, node)) return;
      gestureAt = performance.now();
    };
    const observer = new IntersectionObserver((entries) => {
      if (!(entries.at(-1)?.isIntersecting ?? false)) {
        armed = true;
        return;
      }
      if (!armed || performance.now() - gestureAt > GESTURE_WINDOW_MS) return;
      armed = false;
      gestureAt = Number.NEGATIVE_INFINITY;
      load();
    });
    observer.observe(node);
    for (const type of GESTURES) {
      window.addEventListener(type, noteGesture, { capture: true, passive: true });
    }
    return () => {
      observer.disconnect();
      for (const type of GESTURES) window.removeEventListener(type, noteGesture, { capture: true });
    };
  }, [enabled, node, load]);
  return setNode;
}
