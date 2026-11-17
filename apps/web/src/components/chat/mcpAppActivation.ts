// Exclude activation left by input elsewhere in T3.
const PAGE_ACTIVATION_MS = 5_000;
const CLICK_CONSENT_MS = 5_000;

// Frame input does not bubble here. An app can refocus itself, so focus
// alone cannot exclude activation from input elsewhere in T3.
let lastPageInputAt = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined") {
  const note = () => {
    lastPageInputAt = performance.now();
  };
  if (navigator.userActivation?.isActive) note();
  for (const type of ["pointerdown", "pointerup", "touchend", "keydown"] as const) {
    window.addEventListener(type, note, true);
  }
}

export const pageInputRecent = () => performance.now() - lastPageInputAt < PAGE_ACTIVATION_MS;

export const frameActivated = (frame: HTMLIFrameElement | null) =>
  frame !== null && document.activeElement === frame && navigator.userActivation?.isActive === true;

export interface FrameClicks {
  readonly peek: () => number | undefined;
  readonly take: (click: number | undefined) => boolean;
  readonly dispose: () => void;
}

export const trackFrameClicks = (frame: HTMLIFrameElement): FrameClicks => {
  let armedAt: number | undefined;
  const arm = () => {
    if (frameActivated(frame) && !pageInputRecent()) armedAt = performance.now();
  };
  window.addEventListener("blur", arm);
  return {
    peek: () =>
      armedAt !== undefined &&
      performance.now() - armedAt <= CLICK_CONSENT_MS &&
      frameActivated(frame)
        ? armedAt
        : undefined,
    take: (click) => {
      if (click === undefined || click !== armedAt) return false;
      armedAt = undefined;
      frame.blur();
      return true;
    },
    dispose: () => window.removeEventListener("blur", arm),
  };
};
