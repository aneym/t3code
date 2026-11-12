import { withoutRailsDeskContext } from "@t3tools/client-runtime/user-message";
import * as DateTime from "effect/DateTime";
import { useEffect } from "react";

import type { ComposerHandleRef } from "../../composerHandleContext";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { retryLocalSend } from "../../embed/embedComposerSend";
import {
  actOnHostPendingSend,
  dropLocalSends,
  type EmbedPendingSend,
  useEmbedHostPendingSends,
  useEmbedLocalSends,
} from "../../embed/embedPendingSends";
import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";

type CommittedMessage = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: DateTime.DateTime;
};

const CLOCK_SKEW_MS = 5_000;
const STATE_LABEL = { sending: "Sending", waiting: "Waiting to send", failed: "Not sent" } as const;

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
  readonly onRetry: () => void;
  readonly onEdit: () => void;
  readonly onDiscard: () => void;
}) {
  const failed = props.send.state === "failed";
  return (
    <li
      className="flex w-full flex-col items-end gap-1"
      aria-label={`${STATE_LABEL[props.send.state]}: your message`}
      data-pending-send={props.send.state}
      data-pending-message-id={props.send.messageId ?? undefined}
    >
      <div
        className={cn(
          "min-w-0 max-w-[80%] rounded-2xl border border-dashed px-3 py-2 text-sm",
          failed
            ? "border-destructive/50 text-foreground"
            : "border-muted-foreground/40 text-muted-foreground",
        )}
      >
        <p className="whitespace-pre-wrap wrap-anywhere">{props.send.text}</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-1.5 pe-1 text-muted-foreground text-xs">
        <span className={cn(failed && "text-foreground")}>{STATE_LABEL[props.send.state]}</span>
        {failed && props.send.reason ? (
          <>
            <span aria-hidden>·</span>
            <span className="wrap-anywhere">{props.send.reason}</span>
          </>
        ) : null}
        {failed ? (
          <>
            <span aria-hidden>·</span>
            <InlineButton onClick={props.onRetry}>Retry</InlineButton>
            <span aria-hidden>·</span>
            <InlineButton tone="muted" onClick={props.onEdit}>
              Edit
            </InlineButton>
            <span aria-hidden>·</span>
            <InlineButton tone="muted" onClick={props.onDiscard}>
              Discard
            </InlineButton>
          </>
        ) : null}
      </div>
    </li>
  );
}

export function EmbedPendingSends(props: {
  readonly thread: string;
  readonly messages: ReadonlyArray<CommittedMessage>;
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
}) {
  const local = useEmbedLocalSends(props.thread);
  const host = useEmbedHostPendingSends(props.thread);
  const delivered = local.filter((send) => deliveredIn(props.messages, send));
  const deliveredKey = delivered.map((send) => send.messageId).join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires a pending send once the server has the message it stood for
  useEffect(() => {
    if (deliveredKey !== "") dropLocalSends(props.thread, deliveredKey.split(","));
  }, [deliveredKey, props.thread]);
  const shownLocal = local.filter((send) => !delivered.includes(send));
  const shownHost = host.filter((send) => !deliveredIn(props.messages, send));
  if (shownLocal.length === 0 && shownHost.length === 0) return null;
  const edit = (text: string, release: () => void) => {
    const drafts = useComposerDraftStore.getState();
    const current = drafts.getComposerDraft(props.composerDraftTarget)?.prompt.trimEnd() ?? "";
    drafts.setPrompt(props.composerDraftTarget, current === "" ? text : `${current}\n\n${text}`);
    release();
    requestAnimationFrame(() => props.composerRef.current?.focusAtEnd());
  };
  return (
    <ol
      aria-label="Your messages not sent yet"
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col items-end gap-3 pb-4"
      data-embed-pending-sends=""
    >
      {shownHost.map((send) => (
        <PendingSendRow
          key={send.requestId}
          send={send}
          onRetry={() => actOnHostPendingSend(props.thread, send.requestId, "retry")}
          onEdit={() =>
            edit(send.text, () => actOnHostPendingSend(props.thread, send.requestId, "discard"))
          }
          onDiscard={() => actOnHostPendingSend(props.thread, send.requestId, "discard")}
        />
      ))}
      {shownLocal.map((send) => (
        <PendingSendRow
          key={send.messageId}
          send={send}
          onRetry={() => retryLocalSend(props.thread, send.messageId)}
          onEdit={() => edit(send.text, () => dropLocalSends(props.thread, [send.messageId]))}
          onDiscard={() => dropLocalSends(props.thread, [send.messageId])}
        />
      ))}
    </ol>
  );
}
