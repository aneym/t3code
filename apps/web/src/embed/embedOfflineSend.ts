import { CommandId } from "@t3tools/contracts";

import { holdSend, releaseHeldSend } from "../components/chat/heldSendStore";
import {
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../composerDraftStore";
import type { ComposerHandleRef } from "../composerHandleContext";
import { newMessageId, randomUUID } from "../lib/utils";
import { sendThroughEmbedHost } from "./embedHostSend";

export async function holdOrSendThroughHost(input: {
  readonly routeThreadKey: string;
  readonly thread: string;
  readonly promptAtSend: string;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
}): Promise<void> {
  const { routeThreadKey, promptAtSend, composerDraftTarget: target, promptRef } = input;
  const store = useComposerDraftStore.getState;
  const text = promptAtSend.trim();
  const draft = store().getComposerDraft(target);
  const plain = text !== "" && !(draft && composerDraftHasUserContent({ ...draft, prompt: "" }));
  const ids = { messageId: newMessageId(), commandId: CommandId.make(randomUUID()) };
  const sent = plain
    ? sendThroughEmbedHost(
        { thread: input.thread, requestId: randomUUID(), ...ids, text, when: "queue" },
        (late) => {
          if (late.outcome === "refused") return;
          if (store().getComposerDraft(target)?.prompt.trim() === text) {
            store().clearComposerContent(target);
            if (promptRef.current.trim() === text) promptRef.current = "";
          }
          releaseHeldSend(routeThreadKey);
        },
      )
    : null;
  if (sent === null) return holdSend(routeThreadKey, promptAtSend);
  promptRef.current = "";
  store().clearComposerContent(target);
  input.composerRef.current?.resetCursorState();
  const result = await sent;
  if (result.outcome === "sent" || result.outcome === "held") return;
  if (promptRef.current.trim() === "") {
    promptRef.current = promptAtSend;
    store().setPrompt(target, promptAtSend);
  }
  holdSend(routeThreadKey, promptAtSend, ids);
}
