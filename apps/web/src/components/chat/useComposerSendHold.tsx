import { CircleAlertIcon, Clock3Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  holdEmbedSend,
  noteEmbedComposerThread,
  refuseEmbedSend,
} from "../../embed/embedSendMarks";
import { ensureClientSettingsHydrated, useClientSettingsHydrated } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { OperateAccess } from "../../state/session";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { NO_OPERATE_SCOPE_REFUSAL } from "./composerSendRefusal";

export const MESSAGES_LOADING = "Messages loading";

const HOLD_MS = 15_000;
const WAITING_REASON = "Sends when the chat is ready.";
const NO_OPERATE_REASON = "This chat can only read right now. Your message is still in the box.";
const LOAD_TIMEOUT_REASON = "The chat didn't finish loading. Your message is still in the box.";
const CONNECT_TIMEOUT_REASON =
  "The chat didn't finish connecting. Your message is still in the box.";

interface Hold {
  readonly id: number;
  readonly key: string;
  readonly thread: string | null;
  readonly text: string;
  readonly since: number;
  readonly failed: string | null;
}

function holdCondition(input: {
  readonly thread: string | null;
  readonly settingsReady: boolean;
  readonly reason: string | null;
  readonly providerPending: boolean;
  readonly operate: OperateAccess;
}): string | null {
  if (input.thread === null) return "thread-not-loaded";
  if (!input.settingsReady) return "settings-not-hydrated";
  if (input.reason === MESSAGES_LOADING) return "thread-detail-loading";
  if (input.operate === "pending") return NO_OPERATE_SCOPE_REFUSAL[0];
  if (input.reason === null && input.providerPending) return "provider-loading";
  return null;
}

function refusalReason(input: {
  readonly operate: OperateAccess;
  readonly reason: string | null;
  readonly noProvider: boolean;
}): readonly [condition: string, reason: string] {
  if (input.operate !== "granted") return [NO_OPERATE_SCOPE_REFUSAL[0], NO_OPERATE_REASON];
  if (input.reason !== null) {
    const said = /[.!?]$/.test(input.reason) ? input.reason : `${input.reason}.`;
    return ["send-blocked", `${said} Your message is still in the box.`];
  }
  if (input.noProvider) return ["no-provider", "No model is available. Choose one, then retry."];
  return ["send-blocked", "Your message is still in the box."];
}

export function useComposerSendHold(input: {
  readonly holdKey: string;
  readonly thread: string | null;
  readonly reason: string | null;
  readonly providerPending: boolean;
  readonly noProvider: boolean;
  readonly operate: OperateAccess;
  readonly prompt: string;
}) {
  const { holdKey, thread, operate, prompt } = input;
  const condition = holdCondition({ ...input, settingsReady: useClientSettingsHydrated() });
  const [hold, setHold] = useState<Hold | null>(null);
  const runRef = useRef<() => void>(() => {});
  const nextIdRef = useRef(0);
  const firedIdRef = useRef(-1);
  const shown = hold?.key === holdKey ? hold : null;
  const newHold = (failed: string | null): Hold => ({
    id: nextIdRef.current++,
    key: holdKey,
    thread,
    text: prompt,
    since: Date.now(),
    failed,
  });
  const fail = useStableCallback((failCondition: string, failed: string) => {
    console.warn(`[composer-send] not sent: ${failCondition}`);
    refuseEmbedSend(thread ?? undefined);
    setHold(newHold(failed));
  });
  const run = useStableCallback(() => {
    if (shown === null || firedIdRef.current === shown.id) return;
    firedIdRef.current = shown.id;
    setHold(null);
    runRef.current();
  });
  const drop = useStableCallback(() => {
    if (hold?.failed === null && hold.thread !== null) refuseEmbedSend(hold.thread);
    setHold(null);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the embed send marks which thread this composer sends to
  useEffect(() => noteEmbedComposerThread(thread), [thread]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a send held while the chat loads or connects goes out once it is ready, or turns unsent after the wait
  useEffect(() => {
    if (hold !== null && hold.key !== holdKey) return drop();
    if (shown === null || shown.failed !== null) return;
    if (prompt !== shown.text) return drop();
    if (operate === "read-only") return fail(NO_OPERATE_SCOPE_REFUSAL[0], NO_OPERATE_REASON);
    if (condition === null) return run();
    const timer = setTimeout(
      () =>
        condition === NO_OPERATE_SCOPE_REFUSAL[0]
          ? fail(`${condition}-timeout`, CONNECT_TIMEOUT_REASON)
          : fail(`${condition}-timeout`, LOAD_TIMEOUT_REASON),
      Math.max(0, shown.since + HOLD_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [condition, drop, fail, hold, holdKey, operate, prompt, run, shown]);
  const submit = useStableCallback((send: () => void): false => {
    runRef.current = send;
    if (operate === "read-only" || condition === null) {
      const [refusal, reason] = refusalReason({ ...input, operate });
      fail(refusal, reason);
      return false;
    }
    console.warn(`[composer-send] held: ${condition}`);
    if (condition === "settings-not-hydrated") void ensureClientSettingsHydrated().catch(() => {});
    if (thread !== null) holdEmbedSend(thread, WAITING_REASON);
    setHold((current) =>
      current?.key === holdKey && current.failed === null ? current : newHold(null),
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
              title: "Sending when ready",
              description: WAITING_REASON,
              actions: (
                <Button size="xs" variant="ghost" onClick={drop}>
                  Cancel
                </Button>
              ),
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
  return { blocks: condition !== null || operate !== "granted", submit, clear, banners };
}
