import { withoutRailsDeskContext } from "@t3tools/client-runtime/user-message";
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { CircleAlertIcon, Clock3Icon } from "lucide-react";
import { useEffect } from "react";

import { retryLocalSend } from "../../embed/embedComposerSend";
import {
  actOnHostPendingSend,
  dropLocalSends,
  type EmbedHostSend,
  type EmbedPendingSend,
  useEmbedHostPendingSends,
  useEmbedLocalSends,
} from "../../embed/embedPendingSends";
import { PENDING_STATE_WORDS, PENDING_WORDS } from "../../embed/embedPendingWords";
import { cn } from "~/lib/utils";
import { markdownProseDirection } from "~/textDirection";
import { InlineButton } from "../ui/button";
import {
  BUBBLE_CHIP_CLASS_NAME,
  CollapsibleUserMessageBody,
  USER_BUBBLE_CLASS_NAME,
} from "./UserMessageBody";

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

type CommittedMessage = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: DateTime.DateTime;
};

const CLOCK_SKEW_MS = 5_000;

function heldIn(
  messages: ReadonlyArray<CommittedMessage>,
  send: EmbedPendingSend | EmbedHostSend,
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      (send.messageId !== null
        ? message.id === send.messageId
        : DateTime.toEpochMillis(message.createdAt) >= send.since - CLOCK_SKEW_MS &&
          withoutRailsDeskContext(message.text).trim() === send.text.trim()),
  );
}

function Separator(props: { readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block w-[0.8em] shrink-0 text-center", props.className)}
    >
      {PENDING_WORDS.separator}
    </span>
  );
}

function SentBubble(props: { readonly text: string; readonly failed?: boolean }) {
  return (
    <div
      className={cn(
        USER_BUBBLE_CLASS_NAME,
        BUBBLE_CHIP_CLASS_NAME,
        "bg-message p-3",
        props.failed && "outline-1 -outline-offset-1 outline-dashed outline-destructive",
      )}
    >
      <div dir={markdownProseDirection(props.text)}>
        <CollapsibleUserMessageBody
          text={props.text}
          skills={NO_SKILLS}
          markdownCwd={undefined}
          threadRef={undefined}
        />
      </div>
    </div>
  );
}

const ROW_CLASS_NAME = "flex w-full min-w-0 flex-col items-end gap-1 pb-4";
const STATUS_CLASS_NAME =
  "flex min-h-7 w-full min-w-0 max-w-[80%] sm:min-h-6 items-center justify-end pe-1 text-end text-muted-foreground text-xs";

function PendingSendRow(props: {
  readonly send: EmbedPendingSend | EmbedHostSend;
  readonly onSendNow: (() => void) | null;
  readonly onDiscard: (() => void) | null;
}) {
  const { state, reason } = props.send;
  const ids = {
    "data-pending-message-id": props.send.messageId ?? undefined,
    "data-message-id": props.send.messageId ?? undefined,
  };
  if (state === "delivered") {
    return (
      <li className={ROW_CLASS_NAME} data-pending-send={state} {...ids}>
        <SentBubble text={props.send.text} />
        <div aria-hidden className={STATUS_CLASS_NAME} />
      </li>
    );
  }
  const failed = state === "failed";
  const Icon = state === "waiting" ? Clock3Icon : failed ? CircleAlertIcon : null;
  const actions = props.onSendNow !== null || props.onDiscard !== null;
  return (
    <li
      className={ROW_CLASS_NAME}
      aria-label={PENDING_WORDS.row(state)}
      data-pending-send={state}
      {...ids}
    >
      <SentBubble text={props.send.text} failed={failed} />
      <div aria-live="polite" className={STATUS_CLASS_NAME}>
        <div className="min-w-0 overflow-x-clip">
          <div className="-me-[calc(0.8em_-_2px)] flex flex-wrap items-center justify-end">
            <span className="flex shrink-0 items-center whitespace-nowrap">
              <span className={cn("flex items-center gap-1.5", failed && "text-destructive")}>
                {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null}
                {PENDING_STATE_WORDS[state]}
              </span>
              <Separator />
            </span>
            {reason && state !== "sending" ? (
              <span className="flex min-w-0 items-end" data-pending-reason="">
                <span className="min-w-0 wrap-anywhere">{reason}</span>
                <Separator />
              </span>
            ) : null}
            {actions ? (
              <span
                className="flex shrink-0 items-center justify-end max-md:basis-full pointer-coarse:basis-full"
                data-pending-actions=""
              >
                {props.onSendNow ? (
                  <InlineButton touchTarget="narrow" onClick={props.onSendNow}>
                    {PENDING_WORDS.sendNow}
                  </InlineButton>
                ) : null}
                {props.onSendNow && props.onDiscard ? (
                  <Separator className="max-md:hidden pointer-coarse:hidden" />
                ) : null}
                {props.onDiscard ? (
                  <InlineButton tone="muted" touchTarget="narrow" onClick={props.onDiscard}>
                    {PENDING_WORDS.discard}
                  </InlineButton>
                ) : null}
                <Separator />
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

export function EmbedPendingSends({
  projection,
  rows,
}: {
  readonly projection: {
    readonly thread: { readonly id: string };
    readonly messages: ReadonlyArray<CommittedMessage>;
  };
  readonly rows: ReadonlyArray<{ readonly id: string; readonly inputIntent?: string | undefined }>;
}) {
  const thread = projection.thread.id;
  const local = useEmbedLocalSends(thread);
  const host = useEmbedHostPendingSends(thread);
  const delivered = local.filter((send) => heldIn(projection.messages, send));
  const deliveredKey = delivered.map((send) => send.messageId).join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires a pending send once the server has the message it stood for
  useEffect(() => {
    if (deliveredKey !== "") dropLocalSends(thread, deliveredKey.split(","));
  }, [deliveredKey, thread]);
  const queuedChips = new Set(
    rows.flatMap((row) => (row.inputIntent === "queued_turn" ? [row.id] : [])),
  );
  const shownLocal = local.filter(
    (send) => !delivered.includes(send) && !queuedChips.has(send.messageId),
  );
  const shownHost = host.filter(
    (send) =>
      !heldIn(projection.messages, send) &&
      (send.messageId === null || !queuedChips.has(send.messageId)),
  );
  if (shownLocal.length === 0 && shownHost.length === 0) return null;
  return (
    <ol
      aria-label={PENDING_WORDS.list}
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col items-end"
      data-embed-pending-sends=""
    >
      {shownHost.map((send) => (
        <PendingSendRow
          key={send.requestId}
          send={send}
          onSendNow={
            send.sendNow ? () => actOnHostPendingSend(thread, send.requestId, "retry") : null
          }
          onDiscard={
            send.discard ? () => actOnHostPendingSend(thread, send.requestId, "discard") : null
          }
        />
      ))}
      {shownLocal.map((send) => (
        <PendingSendRow
          key={send.messageId}
          send={send}
          onSendNow={send.state === "failed" ? () => retryLocalSend(thread, send.messageId) : null}
          onDiscard={
            send.state === "failed" ? () => dropLocalSends(thread, [send.messageId]) : null
          }
        />
      ))}
    </ol>
  );
}
