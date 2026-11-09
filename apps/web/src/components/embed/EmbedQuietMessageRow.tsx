import { messageSenderRef } from "@t3tools/contracts";
import { ChevronDown, ChevronRight } from "lucide";
import { use, useState } from "react";

import type { EmbedQuietLine } from "../../embed/embedQuietMessages";
import { useQuietThreadShell } from "../../state/entities";
import { MorphIcon } from "../MorphIcon";
import type { ChatMessage } from "../../types";
import { findRevealRef } from "../chat/markdownFindContext";
import { TimelineRowCtx } from "../chat/timelineRowContext";
import { MessageAuthorHeading } from "../chat/TimelineRowParts";

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
  const from = line.kind === "agent" ? (line.from ?? (sender?.title.trim() || "an agent")) : null;
  const label = from === null ? "Event" : `From ${from}`;
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
        {line.summary.length > 0 ? (
          <span className="min-w-0 truncate text-muted-foreground/70">{line.summary}</span>
        ) : null}
        <MorphIcon className="size-3.5 shrink-0" icon={expanded ? ChevronDown : ChevronRight} />
      </button>
      {expanded || ctx.findActive ? (
        <div
          ref={revealRef}
          hidden={!expanded}
          data-thread-find-text="true"
          className="max-h-96 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-muted-foreground text-xs"
        >
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
