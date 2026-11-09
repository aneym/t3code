import { useSyncExternalStore } from "react";

import { EMBED_OPEN_MESSAGE, type EmbedOutboundMessage } from "./embedProtocol";

export type EmbedHostChannel = {
  readonly target: Window;
  readonly origin: string;
  readonly framed: boolean;
};

export type EmbedHostSpot = { readonly origin: string; readonly framed: boolean };

export type EmbedHostPlacement =
  | { readonly kind: "allowed"; readonly spot: EmbedHostSpot }
  | { readonly kind: "refused"; readonly origin: string | null };

let channel: EmbedHostChannel | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function framingOrigin(): string | null {
  const ancestor = window.location.ancestorOrigins?.[0];
  if (ancestor) return ancestor;
  return URL.canParse(document.referrer) ? new URL(document.referrer).origin : null;
}

export function placeEmbedHost(allowedOrigins: ReadonlySet<string>): EmbedHostPlacement {
  if (window.parent === window) {
    return { kind: "allowed", spot: { origin: window.location.origin, framed: false } };
  }
  const origin = framingOrigin();
  if (origin === null || !allowedOrigins.has(origin)) return { kind: "refused", origin };
  return { kind: "allowed", spot: { origin, framed: true } };
}

export function channelForSpot(spot: EmbedHostSpot): EmbedHostChannel {
  return { target: spot.framed ? window.parent : window, origin: spot.origin, framed: spot.framed };
}

export function connectEmbedHost(next: EmbedHostChannel): () => void {
  channel = next;
  notify();
  return () => {
    if (channel !== next) return;
    channel = null;
    notify();
  };
}

export function useEmbedHostConnected(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => channel !== null,
    () => false,
  );
}

export function postToEmbedHost(message: EmbedOutboundMessage): boolean {
  if (channel === null) return false;
  channel.target.postMessage(message, channel.origin);
  return true;
}

export function openThroughEmbedHost(url: string, tab = false): boolean {
  if (!URL.canParse(url, window.location.href)) return false;
  return postToEmbedHost({
    type: EMBED_OPEN_MESSAGE,
    url: new URL(url, window.location.href).href,
    ...(tab ? { tab } : {}),
  });
}
