import { isEmbedPath } from "./embedProtocol";

let early: Promise<unknown> | null = null;

export function prefetchEmbedDescriptor(): void {
  if (!isEmbedPath(window.location.pathname)) return;
  early = fetch(new URL("/.well-known/t3/environment", window.location.origin), {
    credentials: "omit",
  })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
}

export function takeEarlyEmbedDescriptor(): Promise<unknown> | null {
  const taken = early;
  early = null;
  return taken;
}
