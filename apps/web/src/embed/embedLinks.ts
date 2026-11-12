import { useEffect, useSyncExternalStore } from "react";

import { postToEmbedHost, useEmbedHostConnected } from "./embedHost";
import { EMBED_LINK_ASK_MESSAGE } from "./embedProtocol";

const EMBED_LINKS_MESSAGE = "t3-embed/links";
const KINDS = new Set(["doc", "agent", "lane", "page"]);
const MAX_ORIGINS = 4;
const MAX_REFS = 60;
const MAX_TITLE = 120;
const MAX_URL = 600;
const ASK_BATCH = 30;

export type EmbedLinkRef = { readonly kind: string; readonly title: string; readonly icon: string };

export type EmbedRailsLink = {
  readonly ref: EmbedLinkRef | null;
  readonly mark: string | null;
  readonly gone: boolean;
};

const origins = new Set<string>();
const refs = new Map<string, EmbedLinkRef | "gone" | null>();
const asked = new Set<string>();
const waiting = new Set<string>();
const listeners = new Set<() => void>();
let mark: string | null = null;
let version = 0;
let flushing = false;

function webUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > MAX_URL || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url : null;
}

function readRef(value: unknown): EmbedLinkRef | "gone" | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = value as Record<string, unknown>;
  if (ref.kind === "gone") return "gone";
  const title = typeof ref.title === "string" ? ref.title.trim() : "";
  const icon = webUrl(ref.icon);
  if (typeof ref.kind !== "string" || !KINDS.has(ref.kind) || !title || icon === null) return null;
  return { kind: ref.kind, title: title.slice(0, MAX_TITLE), icon: icon.href };
}

export function applyEmbedLinksMessage(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message.type !== EMBED_LINKS_MESSAGE) return false;
  if (Array.isArray(message.origins)) {
    for (const entry of message.origins.slice(0, MAX_ORIGINS)) {
      const url = webUrl(entry);
      if (url !== null) origins.add(url.origin);
    }
  }
  const icon = webUrl(message.mark);
  if (icon !== null) mark = icon.href;
  if (typeof message.refs === "object" && message.refs !== null) {
    for (const [key, value] of Object.entries(message.refs).slice(0, MAX_REFS)) {
      const url = webUrl(key);
      if (url !== null && origins.has(url.origin)) refs.set(key, readRef(value));
    }
  }
  version += 1;
  for (const listener of listeners) listener();
  return true;
}

function flush(): void {
  flushing = false;
  const urls = [...waiting].slice(0, ASK_BATCH);
  for (const url of urls) {
    waiting.delete(url);
    asked.add(url);
  }
  if (urls.length > 0) postToEmbedHost({ type: EMBED_LINK_ASK_MESSAGE, urls });
  if (waiting.size > 0) queueFlush();
}

function queueFlush(): void {
  if (flushing) return;
  flushing = true;
  setTimeout(flush, 0);
}

export function isEmbedRailsUrl(href: string): boolean {
  const url = webUrl(href);
  return url !== null && origins.has(url.origin);
}

export function useEmbedRailsLink(href: string | undefined): EmbedRailsLink | null {
  const embedded = useEmbedHostConnected();
  const seen = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => 0,
  );
  const link = embedded && href !== undefined && isEmbedRailsUrl(href) ? href : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the Rails host, outside React, once for each shown Rails link's title and icon
  useEffect(() => {
    if (link === null || refs.has(link) || asked.has(link)) return;
    waiting.add(link);
    queueFlush();
  }, [link]);
  return link === null ? null : readLink(link, seen);
}

function readLink(link: string, _seen: number): EmbedRailsLink {
  const ref = refs.get(link) ?? null;
  return { ref: ref === "gone" ? null : ref, mark, gone: ref === "gone" };
}
