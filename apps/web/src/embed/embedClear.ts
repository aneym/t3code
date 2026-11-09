import { useLayoutEffect, useSyncExternalStore } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { TimelineEntry } from "../session-logic";
import { postToEmbedHost } from "./embedHost";
import {
  EMBED_CLEAR_REQUEST_MESSAGE,
  isClearCommand,
  type EmbedClearMark,
  type EmbedClearMessage,
} from "./embedProtocol";

type EmbedClearState = {
  readonly thread: string | null;
  readonly mark: EmbedClearMark | null;
  readonly revealed: boolean;
  readonly kClears: boolean;
};

const LIVE_RUN_STATUSES = new Set(["starting", "running", "waiting"]);

const CLEARED_TOAST = "Cleared the view. The agent's session is untouched.";

let state: EmbedClearState = { thread: null, mark: null, revealed: false, kClears: false };
let timeline: ReadonlyArray<TimelineEntry> = [];
let runningRunId: string | null = null;
const listeners = new Set<() => void>();

function update(next: Partial<EmbedClearState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function useEmbedClearState(): EmbedClearState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export function startEmbedClear(thread: string): () => void {
  update({ thread, mark: null, revealed: false, kClears: false });
  return () => {
    if (state.thread === thread) update({ thread: null, mark: null, revealed: false });
  };
}

export function applyEmbedClearMessage(message: EmbedClearMessage): void {
  if (message.thread !== state.thread) return;
  update({ mark: message.mark, revealed: false });
}

export function setEmbedKClears(kClears: boolean): void {
  update({ kClears });
}

export function embedKClears(): boolean {
  return state.kClears;
}

function isRunning(entry: TimelineEntry): boolean {
  if (entry.kind !== "message") return false;
  const { message } = entry;
  return (
    message.streaming ||
    (message.role === "assistant" && message.runId !== null && message.runId === runningRunId)
  );
}

function markOf(entries: ReadonlyArray<TimelineEntry>): EmbedClearMark {
  const running = entries.findIndex(isRunning);
  const settled = running === -1 ? entries : entries.slice(0, running);
  const last = settled.findLast((entry) => entry.kind === "message");
  return last
    ? { at: last.createdAt, item: last.id }
    : { at: new Date().toISOString(), item: null };
}

function afterClear(
  entries: ReadonlyArray<TimelineEntry>,
  mark: EmbedClearMark | null,
): { readonly shown: ReadonlyArray<TimelineEntry>; readonly hidden: number } {
  if (mark === null) return { shown: entries, hidden: 0 };
  const index = mark.item === null ? -1 : entries.findIndex((entry) => entry.id === mark.item);
  if (index >= 0) return { shown: entries.slice(index + 1), hidden: index + 1 };
  const cut = Date.parse(mark.at);
  const shown = entries.filter((entry) => !(Date.parse(entry.createdAt) <= cut));
  return { shown, hidden: entries.length - shown.length };
}

export function requestEmbedClear(): boolean {
  const thread = state.thread;
  if (thread === null) return false;
  const mark = markOf(timeline);
  const sent = postToEmbedHost({ type: EMBED_CLEAR_REQUEST_MESSAGE, thread, ...mark });
  if (sent) update({ mark, revealed: false });
  return sent;
}

export function claimEmbedClearCommand(prompt: string): boolean {
  if (!isClearCommand(prompt) || !requestEmbedClear()) return false;
  toastManager.add(stackedThreadToast({ type: "success", title: CLEARED_TOAST }));
  return true;
}

export function revealEmbedCleared(): void {
  update({ revealed: true });
}

export function embedLiveRunId(
  runningRun: string | null,
  latestRun: { readonly runId: string; readonly status: string } | null,
): string | null {
  if (runningRun !== null) return runningRun;
  return latestRun !== null && LIVE_RUN_STATUSES.has(latestRun.status) ? latestRun.runId : null;
}

export function useEmbedClearedEntries(
  entries: ReadonlyArray<TimelineEntry>,
  activeRunId: string | null,
  embedPage: boolean,
): { readonly shown: ReadonlyArray<TimelineEntry>; readonly hidden: number } {
  const clear = useEmbedClearState();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed timeline so a clear request marks what the person sees
  useLayoutEffect(() => {
    if (!embedPage) return;
    timeline = entries;
    runningRunId = activeRunId;
  }, [embedPage, entries, activeRunId]);
  if (!embedPage || clear.revealed) return { shown: entries, hidden: 0 };
  return afterClear(entries, clear.mark);
}
