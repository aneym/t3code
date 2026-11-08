import { useSyncExternalStore } from "react";

import type { TimelineEntry } from "../session-logic";
import { toastManager } from "../components/ui/toast";
import { postToEmbedHost } from "./embedHost";
import {
  EMBED_CLEAR_REQUEST_MESSAGE,
  type EmbedClearMarker,
  type EmbedClearMessage,
} from "./embedProtocol";

type ClearView = { readonly marker: EmbedClearMarker | null; readonly showEarlier: boolean };

const CLEAN_VIEW: ClearView = { marker: null, showEarlier: false };

let embedThreadId: string | null = null;
let view: ClearView = CLEAN_VIEW;
let trackedEntries: ReadonlyArray<TimelineEntry> = [];
let kClears = false;
const listeners = new Set<() => void>();

function setView(next: ClearView): void {
  view = next;
  for (const listener of listeners) listener();
}

function entryItemId(entry: TimelineEntry): string {
  return entry.kind === "message" ? entry.message.id : entry.id;
}

function entryStreaming(entry: TimelineEntry): boolean {
  return entry.kind === "message" && entry.message.streaming;
}

function markOf(entries: ReadonlyArray<TimelineEntry>): EmbedClearMarker {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "message" || entry.message.streaming) continue;
    return { at: entry.message.createdAt, item: entry.message.id };
  }
  return { at: new Date().toISOString(), item: null };
}

export function afterClear(
  entries: ReadonlyArray<TimelineEntry>,
  marker: EmbedClearMarker,
): ReadonlyArray<TimelineEntry> {
  const markerIndex =
    marker.item === null ? -1 : entries.findIndex((entry) => entryItemId(entry) === marker.item);
  if (markerIndex >= 0) {
    return entries.filter((entry, index) => index > markerIndex || entryStreaming(entry));
  }
  const at = Date.parse(marker.at);
  return entries.filter((entry) => Date.parse(entry.createdAt) > at || entryStreaming(entry));
}

export function startEmbedClearView(threadId: string): () => void {
  embedThreadId = threadId;
  setView(CLEAN_VIEW);
  return () => {
    if (embedThreadId !== threadId) return;
    embedThreadId = null;
    trackedEntries = [];
    kClears = false;
    setView(CLEAN_VIEW);
  };
}

export function applyEmbedClear(message: EmbedClearMessage): void {
  if (message.thread !== embedThreadId) return;
  setView({ marker: message.marker, showEarlier: false });
}

export function setEmbedKClears(next: boolean): void {
  kClears = next;
}

export function embedKClears(): boolean {
  return kClears;
}

export function trackEmbedTimeline(threadId: string, entries: ReadonlyArray<TimelineEntry>): void {
  if (threadId === embedThreadId) trackedEntries = entries;
}

export function requestEmbedClear(threadId: string | null = embedThreadId): boolean {
  if (threadId === null || threadId !== embedThreadId) return false;
  const marker = markOf(trackedEntries);
  setView({ marker, showEarlier: false });
  postToEmbedHost({ type: EMBED_CLEAR_REQUEST_MESSAGE, thread: threadId, ...marker });
  toastManager.add({
    type: "info",
    title: "Cleared the view.",
    description: "The agent's session is untouched.",
  });
  return true;
}

export function clearEmbedViewFromCommand(prompt: string, threadId: string): boolean {
  return prompt.trim().toLowerCase() === "/clear" && requestEmbedClear(threadId);
}

export function showEarlierInEmbed(): void {
  setView({ ...view, showEarlier: true });
}

export function useEmbedClearView(threadId: string | null): ClearView {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (threadId !== null && threadId === embedThreadId ? view : CLEAN_VIEW),
    () => CLEAN_VIEW,
  );
}
