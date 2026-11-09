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

const draftStore = useComposerDraftStore.getState;

function hand(
  input: ComposerTarget,
  text: string,
  ids: Ids,
  when: "queue" | "steer",
): Promise<EmbedSendSettled> | null {
  const { routeThreadKey, composerDraftTarget: target, promptRef } = input;
  const sent = sendThroughEmbedHost(
    { thread: input.thread, requestId: randomUUID(), ...ids, text: text.trim(), when },
    (late) => {
      if (late.outcome === "refused") return;
      if (draftStore().getComposerDraft(target)?.prompt.trim() === text.trim()) {
        draftStore().clearComposerContent(target);
        if (promptRef.current.trim() === text.trim()) promptRef.current = "";
      }
      releaseHeldSend(routeThreadKey);
    },
  );
  if (sent === null) return null;
  promptRef.current = "";
  draftStore().clearComposerContent(target);
  input.composerRef.current?.resetCursorState();
  return sent;
}

function putBack(input: ComposerTarget, text: string): boolean {
  if (input.promptRef.current.trim() !== "") return false;
  input.promptRef.current = text;
  draftStore().setPrompt(input.composerDraftTarget, text);
  return true;
}

export function sendComposerThroughHost(
  input: ComposerTarget & { readonly text: string; readonly ids: Ids; readonly steer: boolean },
): Promise<void> | null {
  const sent = hand(input, input.text, input.ids, input.steer ? "steer" : "queue");
  if (sent === null) return null;
  return sent.then((result) => {
    if (result.outcome === "sent" || result.outcome === "held") {
      releaseHeldSend(input.routeThreadKey);
      return;
    }
    const restored = putBack(input, input.text);
    if (result.outcome === "unanswered" && restored) {
      holdUnansweredSend(input.routeThreadKey, input.text, input.ids);
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Not sent",
        description:
          result.outcome === "refused"
            ? result.message
            : `No answer from the app, so this wasn't sent: ${input.text.trim().slice(0, 200)}`,
      }),
    );
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
  putBack(input, promptAtSend);
  holdSend(routeThreadKey, promptAtSend, ids);
}
