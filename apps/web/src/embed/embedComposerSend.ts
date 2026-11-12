import { CommandId, type MessageId } from "@t3tools/contracts";

import { holdSend, holdUnansweredSend, releaseHeldSend } from "../components/chat/heldSendStore";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../composerDraftStore";
import type { ComposerHandleRef } from "../composerHandleContext";
import { newMessageId, randomUUID } from "../lib/utils";
import { type EmbedSendSettled, sendThroughEmbedHost } from "./embedHostSend";
import {
  dropLocalSends,
  readLocalSend,
  settleLocalSend,
  trackLocalSend,
} from "./embedPendingSends";
import type { EmbedSendOutcome, EmbedSendWhen } from "./embedProtocol";

interface ComposerTarget {
  readonly routeThreadKey: string;
  readonly thread: string;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
}

interface Ids {
  readonly messageId: MessageId;
  readonly commandId: CommandId;
}

const NO_ANSWER = "No answer from the app, so this wasn't sent.";
const NOT_CONNECTED = "The app isn't connected, so this wasn't sent.";

const draftStore = useComposerDraftStore.getState;

function followLate(thread: string, messageId: string, late: EmbedSendOutcome): void {
  if (late.outcome === "refused") {
    return settleLocalSend(thread, messageId, { state: "failed", reason: late.message });
  }
  if (late.outcome === "held") return settleLocalSend(thread, messageId, { state: "waiting" });
  settleLocalSend(thread, messageId, { state: "sending" });
}

function handToHost(
  thread: string,
  text: string,
  ids: Ids,
  when: EmbedSendWhen,
  onLate: (late: EmbedSendOutcome) => void,
): Promise<EmbedSendSettled> | null {
  const requestId = randomUUID();
  const sent = sendThroughEmbedHost(
    { thread, requestId, ...ids, text: text.trim(), when },
    (late) => {
      followLate(thread, ids.messageId, late);
      onLate(late);
    },
  );
  if (sent === null) return null;
  trackLocalSend(thread, {
    requestId,
    text: text.trim(),
    state: "sending",
    reason: null,
    messageId: ids.messageId,
    commandId: ids.commandId,
    when,
    since: Date.now(),
  });
  return sent.then((result) => {
    if (result.outcome !== "unanswered") followLate(thread, ids.messageId, result);
    return result;
  });
}

function onLateClear(input: ComposerTarget, text: string) {
  const { routeThreadKey, composerDraftTarget: target, promptRef } = input;
  return (late: EmbedSendOutcome) => {
    if (late.outcome === "refused") return;
    if (draftStore().getComposerDraft(target)?.prompt.trim() === text.trim()) {
      draftStore().clearComposerContent(target);
      if (promptRef.current.trim() === text.trim()) promptRef.current = "";
    }
    releaseHeldSend(routeThreadKey);
  };
}

function clearComposer(input: ComposerTarget): void {
  input.promptRef.current = "";
  draftStore().clearComposerContent(input.composerDraftTarget);
  input.composerRef.current?.resetCursorState();
}

function hand(
  input: ComposerTarget,
  text: string,
  ids: Ids,
  when: EmbedSendWhen,
): Promise<EmbedSendSettled> | null {
  const sent = handToHost(input.thread, text, ids, when, onLateClear(input, text));
  if (sent === null) return null;
  clearComposer(input);
  return sent;
}

function putBack(input: ComposerTarget, text: string): boolean {
  if (input.promptRef.current.trim() !== "") return false;
  input.promptRef.current = text;
  draftStore().setPrompt(input.composerDraftTarget, text);
  return true;
}

export async function sendComposerThroughHost(
  input: ComposerTarget & {
    readonly text: string;
    readonly ids: Ids;
    readonly steer: boolean;
    readonly save: () => Promise<boolean>;
  },
): Promise<{ readonly done: Promise<void> } | null> {
  const { thread, text, ids } = input;
  const when = input.steer ? "steer" : "queue";
  trackLocalSend(thread, {
    requestId: randomUUID(),
    text: text.trim(),
    state: "sending",
    reason: null,
    ...ids,
    when,
    since: Date.now(),
  });
  clearComposer(input);
  const saved = await input.save().catch(() => false);
  const sent = saved ? handToHost(thread, text, ids, when, onLateClear(input, text)) : null;
  if (sent === null) {
    dropLocalSends(thread, [ids.messageId]);
    putBack(input, text);
    return null;
  }
  return { done: sent.then((result) => settleComposerSend(input, result)) };
}

function settleComposerSend(
  input: ComposerTarget & { readonly text: string; readonly ids: Ids },
  result: EmbedSendSettled,
): void {
  if (result.outcome !== "unanswered") {
    releaseHeldSend(input.routeThreadKey);
    return;
  }
  dropLocalSends(input.thread, [input.ids.messageId]);
  if (putBack(input, input.text)) {
    holdUnansweredSend(input.routeThreadKey, input.text, input.ids);
    return;
  }
  toastManager.add({
    ...stackedThreadToast({
      type: "warning",
      title: "Not sent",
      description: `${NO_ANSWER} ${input.text.trim().slice(0, 200)}`,
    }),
    id: `embed-host-not-sent:${input.ids.messageId}`,
  });
}

export async function holdOrSendThroughHost(
  input: ComposerTarget & { readonly promptAtSend: string },
): Promise<void> {
  const { routeThreadKey, promptAtSend, composerDraftTarget: target } = input;
  const draft = draftStore().getComposerDraft(target);
  const plain =
    promptAtSend.trim() !== "" && !(draft && composerDraftHasUserContent({ ...draft, prompt: "" }));
  const ids = { messageId: newMessageId(), commandId: CommandId.make(randomUUID()) };
  const sent = plain ? hand(input, promptAtSend, ids, "queue") : null;
  if (sent === null) return holdSend(routeThreadKey, promptAtSend);
  const result = await sent;
  if (result.outcome === "sent" || result.outcome === "held") return;
  dropLocalSends(input.thread, [ids.messageId]);
  putBack(input, promptAtSend);
  holdSend(routeThreadKey, promptAtSend, ids);
}

export function retryLocalSend(thread: string, messageId: string): void {
  const send = readLocalSend(thread, messageId);
  if (send === null || send.state !== "failed") return;
  const ids = {
    messageId: send.messageId as MessageId,
    commandId: CommandId.make(send.commandId),
  };
  dropLocalSends(thread, [messageId]);
  const sent = handToHost(thread, send.text, ids, send.when, () => undefined);
  if (sent === null) {
    trackLocalSend(thread, { ...send, reason: NOT_CONNECTED, since: Date.now() });
    return;
  }
  void sent.then((result) => {
    if (result.outcome === "unanswered") {
      settleLocalSend(thread, messageId, { state: "failed", reason: NO_ANSWER });
    }
  });
}
