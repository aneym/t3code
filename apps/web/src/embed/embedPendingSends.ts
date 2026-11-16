import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { postToEmbedHost } from "./embedHost";
import {
  EMBED_PENDING_SEND_ACTION_MESSAGE,
  type EmbedPendingSendAction,
  type EmbedSendWhen,
} from "./embedProtocol";

export type EmbedPendingState = "sending" | "waiting" | "failed";

export type EmbedHostState = EmbedPendingState | "delivered";

interface EmbedSendItem<State> {
  readonly requestId: string;
  readonly text: string;
  readonly state: State;
  readonly reason: string | null;
  readonly messageId: string | null;
  readonly since: number;
}

export type EmbedPendingSend = EmbedSendItem<EmbedPendingState>;

export interface EmbedHostSend extends EmbedSendItem<EmbedHostState> {
  readonly sendNow: boolean;
  readonly discard: boolean;
}

export interface EmbedLocalSend extends EmbedPendingSend {
  readonly messageId: string;
  readonly commandId: string;
  readonly when: EmbedSendWhen;
}

interface PendingSendsState {
  readonly local: Readonly<Record<string, ReadonlyArray<EmbedLocalSend>>>;
  readonly host: Readonly<Record<string, ReadonlyArray<EmbedHostSend>>>;
  readonly handed: Readonly<Record<string, ReadonlyArray<string>>>;
}

const KEPT_MS = 86_400_000;
const MAX_ITEMS = 50;
const MAX_HANDED = 200;
const MAX_TEXT_LENGTH = 200_000;
const MAX_REASON_LENGTH = 400;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const THREAD = /^[A-Za-z0-9:._-]{1,128}$/;
const EMBED_PENDING_SENDS_MESSAGE = "t3-embed/pending-sends";
const EMPTY: ReadonlyArray<never> = [];
const HOST_STATES: ReadonlyArray<EmbedHostState> = ["sending", "waiting", "failed", "delivered"];

const useStore = create<PendingSendsState>()(
  persist(() => ({ local: {}, host: {}, handed: {} }), {
    name: "t3code:embed-pending-sends",
    version: 1,
    storage: createJSONStorage(() => localStorage),
    partialize: (state) => ({ local: state.local }),
    merge: (persisted, current) => {
      const kept = (persisted as Partial<PendingSendsState> | undefined)?.local ?? {};
      const local = Object.fromEntries(
        Object.entries(kept).map(([thread, sends]) => [
          thread,
          sends.filter((send) => send.state === "failed" && Date.now() - send.since < KEPT_MS),
        ]),
      );
      return { ...current, local };
    },
  }),
);

function updateLocal(
  thread: string,
  change: (sends: ReadonlyArray<EmbedLocalSend>) => ReadonlyArray<EmbedLocalSend>,
): void {
  useStore.setState((state) => {
    const next = change(state.local[thread] ?? EMPTY);
    const rest = { ...state.local };
    delete rest[thread];
    return { local: next.length === 0 ? rest : { ...rest, [thread]: next } };
  });
}

export function trackLocalSend(thread: string, send: EmbedLocalSend): void {
  updateLocal(thread, (sends) => [
    ...sends.filter((existing) => existing.messageId !== send.messageId),
    send,
  ]);
}

export function settleLocalSend(
  thread: string,
  messageId: string,
  next: { readonly state: EmbedPendingState; readonly reason?: string },
): void {
  updateLocal(thread, (sends) =>
    sends.map((send) =>
      send.messageId === messageId
        ? { ...send, state: next.state, reason: next.reason ?? null }
        : send,
    ),
  );
}

export function dropLocalSends(thread: string, messageIds: ReadonlyArray<string>): void {
  if (messageIds.length === 0) return;
  updateLocal(thread, (sends) => sends.filter((send) => !messageIds.includes(send.messageId)));
}

export function readLocalSend(thread: string, messageId: string): EmbedLocalSend | null {
  return useStore.getState().local[thread]?.find((send) => send.messageId === messageId) ?? null;
}

export function useEmbedLocalSends(thread: string): ReadonlyArray<EmbedLocalSend> {
  return useStore((state) => state.local[thread] ?? EMPTY);
}

export function useEmbedHostPendingSends(thread: string): ReadonlyArray<EmbedHostSend> {
  return useStore((state) => state.host[thread] ?? EMPTY);
}

export function useEmbedPendingSendCount(thread: string | undefined): number {
  return useStore((state) =>
    thread === undefined
      ? 0
      : (state.local[thread] ?? EMPTY).length + (state.host[thread] ?? EMPTY).length,
  );
}

export function useEmbedShownRows<Row extends { readonly id: string }>(
  thread: string,
  rows: Row[],
): Row[] {
  const owned = useStore((state) =>
    [
      ...(state.local[thread] ?? EMPTY).map((send) => send.messageId),
      ...(state.host[thread] ?? EMPTY).flatMap((send) => send.messageId ?? []),
      ...(state.handed[thread] ?? EMPTY),
    ].join(","),
  );
  if (owned === "" || rows.length === 0) return rows;
  const ids = new Set(owned.split(","));
  const shown = rows.filter((row) => !ids.has(row.id));
  return shown.length === rows.length ? rows : shown;
}

function readItem(raw: unknown): EmbedHostSend | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const { requestId, text } = item;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT_LENGTH) return null;
  const state = HOST_STATES.find((known) => known === item.state) ?? "sending";
  const reason =
    typeof item.reason === "string" && item.reason.trim() !== ""
      ? item.reason.trim().slice(0, MAX_REASON_LENGTH)
      : null;
  const messageId =
    typeof item.messageId === "string" && REQUEST_ID.test(item.messageId) ? item.messageId : null;
  const at = typeof item.at === "string" ? Date.parse(item.at) : Number.NaN;
  return {
    requestId,
    text,
    state,
    reason,
    messageId,
    since: Number.isNaN(at) ? 0 : at,
    sendNow: item.sendNow === true,
    discard: item.discard === true,
  };
}

export function applyEmbedPendingSendsMessage(data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  const message = data as Record<string, unknown>;
  if (message.type !== EMBED_PENDING_SENDS_MESSAGE) return;
  const { thread, items } = message;
  if (typeof thread !== "string" || !THREAD.test(thread) || !Array.isArray(items)) return;
  const sends = items
    .slice(0, MAX_ITEMS)
    .map(readItem)
    .filter((item) => item !== null);
  const hostRequestIds = new Set(sends.map((send) => send.requestId));
  const hostMessageIds = new Set(sends.flatMap((send) => send.messageId ?? []));
  useStore.setState((state) => {
    const rest = { ...state.host };
    delete rest[thread];
    const was = state.handed[thread] ?? EMPTY;
    const fresh = [...hostMessageIds].filter((id) => !was.includes(id));
    const local = state.local[thread]?.filter(
      (send) => !hostRequestIds.has(send.requestId) && !hostMessageIds.has(send.messageId),
    );
    return {
      host: sends.length === 0 ? rest : { ...rest, [thread]: sends },
      handed:
        fresh.length === 0
          ? state.handed
          : { ...state.handed, [thread]: [...was, ...fresh].slice(-MAX_HANDED) },
      local:
        local === undefined || local.length === state.local[thread]?.length
          ? state.local
          : { ...state.local, [thread]: local },
    };
  });
}

export function actOnHostPendingSend(
  thread: string,
  requestId: string,
  action: EmbedPendingSendAction,
): boolean {
  return postToEmbedHost({ type: EMBED_PENDING_SEND_ACTION_MESSAGE, thread, requestId, action });
}
