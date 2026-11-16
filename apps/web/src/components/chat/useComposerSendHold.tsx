import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { CircleAlertIcon, Clock3Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  holdEmbedSend,
  noteEmbedComposerThread,
  refuseEmbedSend,
} from "../../embed/embedSendMarks";
import { ensureClientSettingsHydrated, useClientSettingsHydrated } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { NO_OPERATE_SCOPE_REFUSAL } from "./composerSendRefusal";

export const MESSAGES_LOADING = "Messages loading";

const HOLD_MS = 15_000;
const WAITING_REASON = "Sends when the chat loads.";
const NO_OPERATE_REASON = "This chat can only read right now. Your message is still in the box.";
const LOAD_TIMEOUT_REASON = "The chat didn't finish loading. Your message is still in the box.";

interface Hold {
  readonly key: string;
  readonly thread: string | null;
  readonly since: number;
  readonly failed: string | null;
}

function loadingCondition(input: {
  readonly thread: string | null;
  readonly settingsReady: boolean;
  readonly reason: string | null;
  readonly providerPending: boolean;
}): string | null {
  if (input.thread === null) return "thread-not-loaded";
  if (!input.settingsReady) return "settings-not-hydrated";
  if (input.reason === MESSAGES_LOADING) return "thread-detail-loading";
  if (input.reason === null && input.providerPending) return "provider-loading";
  return null;
}

function refusalReason(input: {
  readonly canOperate: boolean;
  readonly reason: string | null;
  readonly noProvider: boolean;
}): readonly [condition: string, reason: string] {
  if (!input.canOperate) return [NO_OPERATE_SCOPE_REFUSAL[0], NO_OPERATE_REASON];
  if (input.reason !== null) {
    const said = /[.!?]$/.test(input.reason) ? input.reason : `${input.reason}.`;
    return ["send-blocked", `${said} Your message is still in the box.`];
  }
  if (input.noProvider) return ["no-provider", "No model is available. Choose one, then retry."];
  return ["send-blocked", "Your message is still in the box."];
}

export function useComposerSendHold(input: {
  readonly environmentId: EnvironmentId;
  readonly holdKey: string;
  readonly thread: string | null;
  readonly reason: string | null;
  readonly providerPending: boolean;
  readonly noProvider: boolean;
}) {
  const { holdKey, thread } = input;
  const condition = loadingCondition({ ...input, settingsReady: useClientSettingsHydrated() });
  const [hold, setHold] = useState<Hold | null>(null);
  const runRef = useRef<() => void>(() => {});
  const shown = hold?.key === holdKey ? hold : null;
  const fail = useStableCallback((failCondition: string, failed: string) => {
    console.warn(`[composer-send] not sent: ${failCondition}`);
    refuseEmbedSend(thread ?? undefined);
    setHold({ key: holdKey, thread, since: Date.now(), failed });
  });
  const run = useStableCallback(() => {
    setHold(null);
    runRef.current();
  });
  const drop = useStableCallback(() => {
    if (hold?.failed === null && hold.thread !== null) refuseEmbedSend(hold.thread);
    setHold(null);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the embed send marks which thread this composer sends to
  useEffect(() => noteEmbedComposerThread(thread), [thread]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a send held while the chat loads goes out once it has loaded, or turns unsent after the wait
  useEffect(() => {
    if (hold !== null && hold.key !== holdKey) return drop();
    if (shown === null || shown.failed !== null) return;
    if (condition === null) return run();
    const timer = setTimeout(
      () => fail(`${condition}-timeout`, LOAD_TIMEOUT_REASON),
      Math.max(0, shown.since + HOLD_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [condition, drop, fail, hold, holdKey, run, shown]);
  const submit = useStableCallback((send: () => void): false => {
    runRef.current = send;
    const canOperate = readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
    if (!canOperate || condition === null) {
      const [refusal, reason] = refusalReason({ ...input, canOperate });
      fail(refusal, reason);
      return false;
    }
    console.warn(`[composer-send] held: ${condition}`);
    if (condition === "settings-not-hydrated") void ensureClientSettingsHydrated().catch(() => {});
    if (thread !== null) holdEmbedSend(thread, WAITING_REASON);
    setHold((current) =>
      current?.key === holdKey && current.failed === null
        ? current
        : { key: holdKey, thread, since: Date.now(), failed: null },
    );
    return false;
  });
  const clear = useStableCallback(() => {
    if (hold !== null) setHold(null);
  });
  const banners: ComposerBannerStackItem[] =
    shown === null
      ? []
      : shown.failed === null
        ? [
            {
              id: "send-hold",
              variant: "info",
              icon: <Clock3Icon />,
              title: "Waiting",
              description: WAITING_REASON,
            },
          ]
        : [
            {
              id: "send-hold",
              variant: "warning",
              icon: <CircleAlertIcon />,
              title: "Not sent",
              description: shown.failed,
              actions: (
                <Button size="xs" variant="ghost" onClick={run}>
                  Retry
                </Button>
              ),
              dismissLabel: "Dismiss",
              onDismiss: clear,
            },
          ];
  return { blocks: condition !== null, submit, clear, banners };
}
