import { messageSenderRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { use, useState } from "react";

import { noteRunOf } from "../../embed/embedNoteRuns";
import { useEmbedHostConnected } from "../../embed/embedHost";
import { embedQuietLine, type EmbedQuietLine } from "../../embed/embedQuietMessages";
import { embedSeenAt } from "../../embed/embedSeen";
import { useQuietThreadShell } from "../../state/entities";
import { formatShortTimestamp } from "../../timestampFormat";
import type { ChatMessage } from "../../types";
import { findRevealRef } from "../chat/markdownFindContext";
import { TimelineRowCtx } from "../chat/timelineRowContext";
import { MessageAuthorHeading } from "../chat/TimelineRowParts";

export function useEmbedQuietLine(message: ChatMessage): EmbedQuietLine | null {
  return useEmbedHostConnected() ? embedQuietLine(message) : null;
}

export function EmbedQuietMessageRow({
  message,
  line,
}: {
  readonly message: ChatMessage;
  readonly line: EmbedQuietLine;
}) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const sender = useQuietThreadShell(
    line.kind === "agent" && line.from === undefined
      ? messageSenderRef(message, ctx.activeThreadEnvironmentId)
      : null,
  );
  const run = line.kind === "note" ? noteRunOf(message) : null;
  const seen = run === null || ctx.threadRef === null ? null : embedSeenAt(ctx.threadRef.threadId);
  const fresh = seen !== null && run !== null && run.every((note) => note.createdAt > seen);
  const from = line.kind === "agent" ? (line.from ?? (sender?.title.trim() || "an agent")) : null;
  const label =
    run !== null
      ? `${run.length} updates${fresh ? " since you were here" : ""}`
      : line.kind === "note"
        ? "Note"
        : from === null
          ? "Event"
          : `From ${from}`;
  const time = (note: ChatMessage) => formatShortTimestamp(note.createdAt, ctx.timestampFormat);
  const first = run === null ? time(message) : time(run[0]!);
  const last = run === null ? first : time(run[run.length - 1]!);
  const span = first === last ? first : `${first}–${last}`;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1" data-embed-quiet-line={line.kind}>
      <MessageAuthorHeading>{label}</MessageAuthorHeading>
      <button
        type="button"
        aria-expanded={expanded}
        data-scroll-anchor-ignore
        onClick={() => setExpanded((value) => !value)}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="shrink-0">{label}</span>
        {line.kind === "note" ? (
          <span className="shrink-0 tabular-nums text-muted-foreground/70">{span}</span>
        ) : null}
        {run === null && line.summary.length > 0 ? (
          <span className="min-w-0 truncate text-muted-foreground/70">{line.summary}</span>
        ) : null}
        {expanded ? (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0" />
        )}
      </button>
      {expanded || ctx.findActive ? (
        <div
          ref={revealRef}
          hidden={!expanded}
          data-thread-find-text="true"
          className="max-h-96 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-muted-foreground text-xs"
        >
          {run === null
            ? message.text
            : run.map((note) => (
                <div key={note.id} className="flex gap-2 py-1" data-embed-note-run-item="">
                  <span className="shrink-0 tabular-nums text-muted-foreground/70">
                    {time(note)}
                  </span>
                  <span className="min-w-0">{note.text}</span>
                </div>
              ))}
        </div>
      ) : null}
    </div>
  );
}
