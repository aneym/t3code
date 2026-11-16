import { withoutRailsDeskContext } from "@t3tools/client-runtime/user-message";
import * as DateTime from "effect/DateTime";
import { CircleAlertIcon, Clock3Icon } from "lucide-react";
import { useEffect } from "react";

import { retryLocalSend } from "../../embed/embedComposerSend";
import {
  actOnHostPendingSend,
  dropLocalSends,
  type EmbedPendingSend,
  useEmbedHostPendingSends,
  useEmbedLocalSends,
} from "../../embed/embedPendingSends";
import { PENDING_STATE_WORDS, PENDING_WORDS } from "../../embed/embedPendingWords";
import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";

type CommittedMessage = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: DateTime.DateTime;
};

const CLOCK_SKEW_MS = 5_000;

function deliveredIn(messages: ReadonlyArray<CommittedMessage>, send: EmbedPendingSend): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      (message.id === send.messageId ||
        (DateTime.toEpochMillis(message.createdAt) >= send.since - CLOCK_SKEW_MS &&
          withoutRailsDeskContext(message.text).trim() === send.text.trim())),
  );
}

function PendingSendRow(props: {
  readonly send: EmbedPendingSend;
  readonly onSendNow: (() => void) | null;
  readonly onDiscard: (() => void) | null;
}) {
  const { state, reason } = props.send;
  const failed = state === "failed";
  const Icon = state === "waiting" ? Clock3Icon : failed ? CircleAlertIcon : null;
  return (
    <li
      className="flex w-full min-w-0 flex-col items-end gap-1"
      aria-label={PENDING_WORDS.row(state)}
      data-pending-send={state}
      data-pending-message-id={props.send.messageId ?? undefined}
      data-message-id={props.send.messageId ?? undefined}
    >
      <div
        className={cn(
          "min-w-0 max-w-[80%] rounded-2xl bg-message px-3 py-2 text-message-foreground text-sm",
          failed && "border border-dashed border-destructive",
        )}
      >
        <p className="whitespace-pre-wrap wrap-anywhere">{props.send.text}</p>
      </div>
      <div
        aria-live="polite"
        className="flex min-w-0 max-w-[80%] flex-wrap items-center justify-end gap-x-1.5 pe-1 text-end text-muted-foreground text-xs"
      >
        {Icon ? (
          <Icon aria-hidden className={cn("size-3.5 shrink-0", failed && "text-destructive")} />
        ) : null}
        <span className={cn(failed && "text-destructive")}>{PENDING_STATE_WORDS[state]}</span>
        {reason && state !== "sending" ? (
          <span className="min-w-0 wrap-anywhere">
            <span aria-hidden>{PENDING_WORDS.separator.trimStart()}</span>
            {reason}
          </span>
        ) : null}
        {props.onSendNow ? (
          <InlineButton touchTarget="narrow" onClick={props.onSendNow}>
            {PENDING_WORDS.sendNow}
          </InlineButton>
        ) : null}
        {props.onDiscard ? (
          <InlineButton tone="muted" touchTarget="narrow" onClick={props.onDiscard}>
            {PENDING_WORDS.discard}
          </InlineButton>
        ) : null}
      </div>
    </li>
  );
}

export function EmbedPendingSends({
  projection,
}: {
  readonly projection: {
    readonly thread: { readonly id: string };
    readonly messages: ReadonlyArray<CommittedMessage>;
  };
}) {
  const thread = projection.thread.id;
  const local = useEmbedLocalSends(thread);
  const host = useEmbedHostPendingSends(thread);
  const delivered = local.filter((send) => deliveredIn(projection.messages, send));
  const deliveredKey = delivered.map((send) => send.messageId).join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires a pending send once the server has the message it stood for
  useEffect(() => {
    if (deliveredKey !== "") dropLocalSends(thread, deliveredKey.split(","));
  }, [deliveredKey, thread]);
  const shownLocal = local.filter((send) => !delivered.includes(send));
  const shownHost = host.filter((send) => !deliveredIn(projection.messages, send));
  if (shownLocal.length === 0 && shownHost.length === 0) return null;
  return (
    <ol
      aria-label={PENDING_WORDS.list}
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col items-end gap-3 pb-4"
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
