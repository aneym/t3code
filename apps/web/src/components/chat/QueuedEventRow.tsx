import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type { McpEventMessageSource } from "@t3tools/contracts";

import { mcpEventLabel } from "../../mcpEventMessage";

export function QueuedEventRow({
  event,
  text,
}: {
  readonly event: Partial<McpEventMessageSource>;
  readonly text: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div
      className="flex w-full min-w-0 flex-col items-start gap-1"
      data-queued-event={event.name ?? ""}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="shrink-0">Event</span>
        <span className="min-w-0 truncate text-muted-foreground/70">{mcpEventLabel(event)}</span>
        <Chevron aria-hidden className="size-3.5 shrink-0" />
      </button>
      {expanded ? (
        <div className="max-h-96 w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-muted-foreground text-xs">
          {text}
        </div>
      ) : null}
    </div>
  );
}
