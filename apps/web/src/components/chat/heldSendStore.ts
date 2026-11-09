import { CommandId, type MessageId } from "@t3tools/contracts";
import { create } from "zustand";

import { newMessageId, randomUUID } from "~/lib/utils";

export const HELD_SEND_LIMIT_MS = 60_000;

export interface HeldSend {
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly since: number;
  readonly status: "waiting" | "failed";
}

interface HeldSendState {
  readonly byThread: Readonly<Record<string, HeldSend>>;
}

export const useHeldSendStore = create<HeldSendState>(() => ({ byThread: {} }));

function put(threadKey: string, next: HeldSend | null): void {
  useHeldSendStore.setState((state) => {
    const rest = { ...state.byThread };
    delete rest[threadKey];
    return { byThread: next === null ? rest : { ...rest, [threadKey]: next } };
  });
}

const readHeldSend = (threadKey: string): HeldSend | null =>
  useHeldSendStore.getState().byThread[threadKey] ?? null;

const sameText = (held: HeldSend | null, text: string): held is HeldSend =>
  held !== null && held.text.trim() === text.trim();

export function heldIdsFor(
  threadKey: string,
  text: string,
): { readonly messageId: MessageId; readonly commandId: CommandId } | null {
  const held = readHeldSend(threadKey);
  return sameText(held, text) ? { messageId: held.messageId, commandId: held.commandId } : null;
}

export function holdSend(
  threadKey: string,
  text: string,
  ids?: { readonly messageId: MessageId; readonly commandId: CommandId },
): void {
  const held = readHeldSend(threadKey);
  const same = sameText(held, text);
  put(threadKey, {
    messageId: ids?.messageId ?? (same ? held.messageId : newMessageId()),
    commandId: ids?.commandId ?? (same ? held.commandId : CommandId.make(randomUUID())),
    text,
    since: same && held.status === "waiting" ? held.since : Date.now(),
    status: "waiting",
  });
}

export function failHeldSend(threadKey: string): void {
  const held = readHeldSend(threadKey);
  if (held?.status === "waiting") put(threadKey, { ...held, status: "failed" });
}

export function retryHeldSend(threadKey: string): void {
  const held = readHeldSend(threadKey);
  if (held) put(threadKey, { ...held, since: Date.now(), status: "waiting" });
}

export function releaseHeldSend(threadKey: string): void {
  if (readHeldSend(threadKey)) put(threadKey, null);
}
