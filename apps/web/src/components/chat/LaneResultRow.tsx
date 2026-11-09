import {
  LANE_RESULT_STATE_LABELS,
  type LaneResult,
  type LaneResultState,
} from "@t3tools/client-runtime/lane-result";
import { ChevronRightIcon } from "lucide-react";
import { use, useState } from "react";

import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { findRevealRef } from "./markdownFindContext";
import { TimelineRowCtx } from "./timelineRowContext";
import { MessageAuthorHeading } from "./TimelineRowParts";

const MARK_CLASS: Record<LaneResultState, string> = {
  finished: "bg-current",
  dropped: "border border-current",
  failed: "bg-destructive",
};

const EMPTY_DETAIL: Record<LaneResultState, string> = {
  finished: "The lane left no result.",
  dropped: "The lane left no reason.",
  failed: "Rails gave no reason.",
};

export function LaneResultRow({ lane }: { readonly lane: LaneResult }) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const title = lane.title || "A lane";
  const state = LANE_RESULT_STATE_LABELS[lane.state];
  return (
    <div
      className="flex min-w-0 flex-col items-start py-0.5 text-muted-foreground text-xs"
      data-lane-result={lane.state}
    >
      <MessageAuthorHeading>{`${title} ${state}`}</MessageAuthorHeading>
      <button
        type="button"
        aria-expanded={expanded}
        data-scroll-anchor-ignore
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", MARK_CLASS[lane.state])}
        />
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0">· {state}</span>
      </button>
      {expanded || ctx.findActive ? (
        <div
          ref={revealRef}
          hidden={!expanded}
          data-thread-find-text="true"
          className="mt-1 ml-[11px] max-h-96 min-w-0 overflow-auto border-border border-l py-0.5 pl-3"
        >
          {lane.detail ? (
            <ChatMarkdown
              text={lane.detail}
              cwd={ctx.markdownCwd}
              environmentId={ctx.activeThreadEnvironmentId}
              className="text-muted-foreground text-xs"
            />
          ) : (
            <p>{EMPTY_DETAIL[lane.state]}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
