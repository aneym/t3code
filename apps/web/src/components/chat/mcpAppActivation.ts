// Exclude activation left by input elsewhere in T3.
const PAGE_ACTIVATION_MS = 5_000;
const CLICK_CONSENT_MS = 5_000;
const TAB_ENTRY_MS = 250;
const PAGE_PRESS_MS = 2_000;

// Frame input does not bubble here. An app can refocus itself, so focus
// alone cannot exclude activation from input elsewhere in T3.
let lastPageInputAt = Number.NEGATIVE_INFINITY;
let lastPagePressAt = Number.NEGATIVE_INFINITY;
let lastPageTabAt = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined") {
  const note = (event: Event) => {
    lastPageInputAt = performance.now();
    if (!(event instanceof KeyboardEvent)) {
      lastPagePressAt = lastPageInputAt;
    } else if (event.key === "Enter" || event.key === " ") {
      lastPagePressAt = lastPageInputAt;
    } else if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      lastPageTabAt = lastPageInputAt;
    }
  };
  if (navigator.userActivation?.isActive) {
    lastPageInputAt = performance.now();
    lastPagePressAt = lastPageInputAt;
  }
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
  readonly peekKey: () => number | undefined;
  readonly takeKey: (entry: number | undefined) => boolean;
  readonly dispose: () => void;
}

export const trackFrameClicks = (frame: HTMLIFrameElement): FrameClicks => {
  let armedAt: number | undefined;
  let enteredAt: number | undefined;
  const arm = () => {
    const clicked = frameActivated(frame) && !pageInputRecent();
    if (clicked) armedAt = performance.now();
    const now = performance.now();
    const tabbed = lastPageTabAt === lastPageInputAt && now - lastPageTabAt <= TAB_ENTRY_MS;
    enteredAt = document.activeElement === frame && (clicked || tabbed) ? now : undefined;
  };
  const leave = () => {
    enteredAt = undefined;
  };
  window.addEventListener("blur", arm);
  window.addEventListener("focus", leave);
  return {
    peek: () =>
      armedAt !== undefined &&
      performance.now() - armedAt <= CLICK_CONSENT_MS &&
      lastPageInputAt < armedAt &&
      navigator.userActivation?.isActive === true &&
      (document.activeElement === frame || !document.hasFocus())
        ? armedAt
        : undefined,
    take: (click) => {
      if (click === undefined || click !== armedAt) return false;
      armedAt = undefined;
      frame.blur();
      return true;
    },
    peekKey: () => (enteredAt !== undefined && frameActivated(frame) ? enteredAt : undefined),
    takeKey: (entry) => {
      if (entry === undefined || entry !== enteredAt) return false;
      enteredAt = undefined;
      if (performance.now() - lastPagePressAt < PAGE_PRESS_MS) return false;
      frame.blur();
      return true;
    },
    dispose: () => {
      window.removeEventListener("blur", arm);
      window.removeEventListener("focus", leave);
    },
  };
};
