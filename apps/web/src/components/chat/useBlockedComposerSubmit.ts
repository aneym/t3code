import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { embedSendEnter, failEmbedSend } from "../../embed/embedSendMarks";
import { useStableCallback } from "../../hooks/useStableCallback";
import { newMessageId } from "../../lib/utils";
import { readEnvironmentScope } from "../../state/session";
import {
  type ComposerSendRefusal,
  MESSAGES_LOADING_REFUSAL,
  NO_OPERATE_SCOPE_REFUSAL,
  refuseComposerSend,
} from "./composerSendRefusal";

export const MESSAGES_LOADING = "Messages loading";

const LOADING_WAIT_MS = 20_000;

function blockedComposerRefusal(input: {
  readonly canOperate: boolean;
  readonly reason: string | null;
  readonly noProvider: boolean;
}): ComposerSendRefusal {
  if (!input.canOperate) return NO_OPERATE_SCOPE_REFUSAL;
  if (input.reason !== null) {
    const said = /[.!?]$/.test(input.reason) ? input.reason : `${input.reason}.`;
    return ["send-blocked", "Not sent", `${said} Your message is still in the box.`];
  }
  if (input.noProvider) {
    return ["no-provider", "Not sent: no model available", "Choose a model, then send again."];
  }
  return ["send-blocked", "Not sent", "Your message is still in the box. Try again in a moment."];
}

export function useBlockedComposerSubmit(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: string | null;
  readonly loading: boolean;
  readonly reason: string | null;
  readonly noProvider: boolean;
}): (submit: () => void) => false {
  const { thread, loading } = input;
  const waitingRef = useRef<{ thread: string | null; since: number } | null>(null);
  const [heldAt, setHeldAt] = useState<number | null>(null);
  const submitRef = useRef<() => void>(() => {});
  const refuse = useStableCallback((refusal: ComposerSendRefusal) => {
    refuseComposerSend(refusal);
    if (thread !== null) failEmbedSend(embedSendEnter(thread, newMessageId()), "rejected");
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an Enter pressed while the thread loads sends once it has loaded, or reports itself unsent after the wait
  useEffect(() => {
    const waiting = waitingRef.current;
    if (heldAt === null || waiting === null) return;
    if (waiting.thread !== thread || !loading) {
      waitingRef.current = null;
      if (waiting.thread === thread) submitRef.current();
      return;
    }
    const timer = setTimeout(
      () => {
        waitingRef.current = null;
        refuse(MESSAGES_LOADING_REFUSAL);
      },
      Math.max(0, waiting.since + LOADING_WAIT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [heldAt, loading, refuse, thread]);
  return useStableCallback((submit: () => void) => {
    const canOperate = readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
    if (!loading || !canOperate) {
      refuse(blockedComposerRefusal({ ...input, canOperate }));
      return false;
    }
    submitRef.current = submit;
    console.warn("[composer-send] held: thread-detail-loading");
    const waiting = waitingRef.current ?? { thread, since: Date.now() };
    waitingRef.current = waiting;
    setHeldAt(waiting.since);
    return false;
  });
}
