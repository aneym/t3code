import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { observeResize } from "~/lib/observeResize";

// The folds clip with `max-h-44`, which is 11rem.
const FOLDED_HEIGHT_REM = 11;

type Measure = (remPx: number) => void;

const pending = new Set<Measure>();

const readRemPx = () =>
  Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

function measurePending() {
  if (pending.size === 0) return;
  const remPx = readRemPx();
  const measures = [...pending];
  pending.clear();
  flushSync(() => {
    for (const measure of measures) measure(remPx);
  });
}

/**
 * Put `ref` on the unclipped content inside a fold. `tallEnough` is true when that content is at
 * least twice the folded height, so opening a fold always at least doubles what was on screen.
 */
export function useTallEnoughToFold(enabled = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [tallEnough, setTallEnough] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the fold depends on the rendered height, which only the DOM knows
  useLayoutEffect(() => {
    const content = ref.current;
    if (!enabled || !content) return;
    const measure: Measure = (remPx) =>
      setTallEnough(content.offsetHeight >= FOLDED_HEIGHT_REM * 2 * remPx);
    // Folds mounted in one commit share one layout read before paint; waiting for the observer
    // would paint one unfolded frame.
    if (pending.size === 0) queueMicrotask(measurePending);
    pending.add(measure);
    const stop = observeResize(content, () => measure(readRemPx()));
    return () => {
      pending.delete(measure);
      stop();
    };
  }, [enabled]);
  return { ref, tallEnough: enabled && tallEnough };
}
