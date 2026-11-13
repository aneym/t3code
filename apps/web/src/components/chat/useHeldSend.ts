import type { MessageId } from "@t3tools/contracts";
import { useEffect, type RefObject } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { ChatComposerHandle } from "./ChatComposer";
import { releaseHeldSend, retryHeldSend, useHeldSendStore } from "./heldSendStore";

export function useHeldSend(input: {
  readonly threadKey: string;
  readonly draftTarget: ComposerThreadTarget;
  readonly hasAttachments: boolean;
  readonly messages: ReadonlyArray<{ readonly id: MessageId }> | undefined;
  readonly promptRef: { current: string };
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly unavailable: boolean;
  readonly busy: boolean;
  readonly send: () => unknown;
}) {
  const { threadKey, draftTarget, composerRef, promptRef, send, unavailable } = input;
  const held = useHeldSendStore((store) => store.byThread[threadKey] ?? null);
  const prompt = useComposerDraftStore(
    (store) => store.getComposerDraft(draftTarget)?.prompt ?? "",
  );
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const composerHoldsIt = held !== null && prompt.trim() === held.text.trim();
  const shown = held !== null && (prompt.trim() !== "" || input.hasAttachments);
  const delivered =
    held !== null && input.messages?.some((message) => message.id === held.messageId) === true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- once the server has the held message, its text leaves the composer and the held marker is dropped, so it can't be sent twice
  useEffect(() => {
    if (!delivered) return;
    if (composerHoldsIt) {
      promptRef.current = "";
      setPrompt(draftTarget, "");
      composerRef.current?.resetCursorState();
    }
    releaseHeldSend(threadKey);
  }, [composerHoldsIt, composerRef, delivered, draftTarget, promptRef, setPrompt, threadKey]);
  const ready = shown && held.status === "waiting" && !delivered && !unavailable && !input.busy;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends a held message once its environment is connected again
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => void send(), 1_500);
    return () => clearTimeout(timer);
  }, [ready, send]);
  const retry = useStableCallback(() => {
    retryHeldSend(threadKey);
    if (!unavailable) void send();
  });
  return { held: shown && !delivered ? held : null, retry };
}
