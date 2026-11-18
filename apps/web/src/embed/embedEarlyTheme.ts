import { EMBED_THEME_MESSAGE, isEmbedPath } from "./embedProtocol";

let early: MessageEvent | null = null;

const keep = (event: MessageEvent) => {
  const data: unknown = event.data;
  if (typeof data === "object" && data !== null && "type" in data) {
    if (data.type === EMBED_THEME_MESSAGE) early = event;
  }
};

export function listenForEarlyEmbedTheme(): void {
  if (window.parent === window || !isEmbedPath(window.location.pathname)) return;
  window.addEventListener("message", keep);
}

export function takeEarlyEmbedTheme(): MessageEvent | null {
  window.removeEventListener("message", keep);
  const event = early;
  early = null;
  return event;
}
