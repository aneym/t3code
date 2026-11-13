import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";
import { CalendarClockIcon, MessagesSquareIcon } from "lucide-react";
import * as DateTime from "effect/DateTime";
import { useState, type ReactNode } from "react";
import { useEmbedHostConnected } from "../../embed/embedHost";
import { isEmbedPersonMessage } from "../../embed/embedQuietMessages";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";
import { GuestMessageName } from "./guestMessageStyle";
import type { QueuedRowThumbnail } from "./queuedRunRows";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { FoldedMessageHeader, useScheduledTaskTitle } from "./TimelineUserMessageRow";
import { AppSentNote } from "./AppSentNote";

type QueuedRunMessage = Parameters<typeof deriveThreadQueueWorkflowState>[0]["messages"][number];

/** A queued turn wears its sent form's attribution; only the dashed edge and controls differ. */
export function QueuedMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly message: QueuedRunMessage | undefined;
  readonly previewText: string;
  readonly thumbnails: ReadonlyArray<QueuedRowThumbnail>;
  readonly isEditing: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly children: ReactNode;
}) {
  const presentation = props.message ? resolveUserMessagePresentation(props.message) : null;
  const person = useEmbedHostConnected() && !!props.message && isEmbedPersonMessage(props.message);
  const attribution = person ? null : (presentation?.attribution ?? null);
  const scheduledTaskId = presentation?.scheduledTaskId;
  const senderThreadId = props.message?.senderThreadId;
  // A linked environment's agent sent it from a thread there.
  const senderRef =
    props.message?.linkedSender ??
    (senderThreadId === undefined ? null : scopeThreadRef(props.environmentId, senderThreadId));
  const [expanded, setExpanded] = useState(false);
  const taskTitle = useScheduledTaskTitle(props.environmentId, scheduledTaskId);
  const senderShell = useQuietThreadShell(attribution === "agent" ? senderRef : null);
  const linkedSenderEnvironment = useEnvironment(
    props.message?.linkedSender?.environmentId ?? null,
  );
  const fold =
    attribution === "automation"
      ? {
          icon: CalendarClockIcon,
          label: "Automation",
          summary: taskTitle ?? props.previewText.split(/\r?\n/, 1)[0] ?? "",
        }
      : attribution === "agent"
        ? {
            icon: MessagesSquareIcon,
            label:
              senderShell?.title.trim() || props.message?.linkedSender?.title.trim() || "Agent",
            summary: props.previewText.split(/\r?\n/).find((line) => line.trim()) ?? "",
          }
        : null;
  const bodyVisible = fold === null || expanded;

  return (
    <>
      {attribution === "t3code" ? <AppSentNote /> : null}
      {presentation?.guestName === undefined ? null : (
        <GuestMessageName name={presentation.guestName} />
      )}
      {/* Dashed and unfilled: a turn that has not been sent yet. */}
      <div
        className={cn(
          "flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed text-sm",
          props.isEditing
            ? "border-primary/60 text-foreground"
            : attribution === "guest"
              ? "border-guest/50 text-muted-foreground"
              : "border-muted-foreground/40 text-muted-foreground",
          fold === null && "px-3 py-2",
          fold !== null && expanded && "w-full",
        )}
      >
        {fold ? (
          <FoldedMessageHeader
            icon={fold.icon}
            label={fold.label}
            summary={fold.summary}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
        {bodyVisible ? (
          <div
            className={cn(
              "flex flex-col gap-2",
              fold !== null && "max-h-96 overflow-auto px-3 pb-2",
            )}
          >
            {props.thumbnails.length > 0 ? (
              <span className="flex flex-wrap items-center gap-1">
                {props.thumbnails.map((thumbnail) => (
                  <span
                    key={thumbnail.key}
                    className="size-8 overflow-hidden rounded-md border border-border/70 bg-background"
                  >
                    {thumbnail.url ? (
                      <img
                        src={thumbnail.url}
                        alt={thumbnail.name}
                        className="size-full object-cover"
                      />
                    ) : (
                      <span aria-label={thumbnail.name} className="block size-full bg-muted/60" />
                    )}
                  </span>
                ))}
              </span>
            ) : null}
            {/* In full, like a sent turn: a queued message is read before it is sent. */}
            {props.previewText ? (
              <p className="whitespace-pre-wrap wrap-anywhere">{props.previewText}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5 pe-1 text-xs text-muted-foreground">
        {props.message ? (
          <span className="me-1 flex items-center gap-2 px-1 opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/queued:opacity-100">
            {attribution === "agent" &&
            senderRef &&
            // Only an environment this client is connected to can open the sender's thread there.
            (props.message?.linkedSender === undefined || linkedSenderEnvironment !== null) ? (
              <InlineButton
                tone="muted"
                onClick={() => props.onOpenThread(senderRef.threadId, senderRef.environmentId)}
              >
                Open thread
              </InlineButton>
            ) : null}
            {scheduledTaskId ? (
              <InlineButton
                tone="muted"
                render={
                  <Link
                    to="/settings/scheduled-tasks"
                    search={{ environmentId: props.environmentId, taskId: scheduledTaskId }}
                  />
                }
              >
                Open automation
              </InlineButton>
            ) : null}
            <TimelineRowTimestamp
              createdAt={DateTime.formatIso(props.message.createdAt)}
              timestampFormat={props.timestampFormat}
              alwaysVisible
            />
          </span>
        ) : null}
        {props.children}
      </div>
    </>
  );
}
