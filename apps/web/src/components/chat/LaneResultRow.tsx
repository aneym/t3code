import {
  LANE_RESULT_VERBS,
  type LaneResult,
  type LaneResultState,
} from "@t3tools/client-runtime/lane-result";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { use, useState } from "react";

import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { findRevealRef } from "./markdownFindContext";
import { TimelineRowCtx } from "./timelineRowContext";
import { MessageAuthorHeading } from "./TimelineRowParts";

function LaneResultGlyph({ state }: { readonly state: LaneResultState }) {
  return state === "dropped" ? (
    <XIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2.5} />
  ) : (
    <i
      aria-hidden
      className={cn(
        "block size-2.5 shrink-0 rounded-full",
        state === "failed" ? "bg-destructive" : "bg-muted-foreground",
      )}
    />
  );
}

const EMPTY_DETAIL: Record<LaneResultState, string> = {
  finished: "The lane left no result.",
  dropped: "The lane left no reason.",
  failed: "Rails gave no reason.",
};

export function LaneResultRow({ lane }: { readonly lane: LaneResult }) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const title = lane.title || "a lane";
  const verb = LANE_RESULT_VERBS[lane.state];
  return (
    <div
      className="flex min-w-0 flex-col items-start py-0.5 text-muted-foreground text-xs"
      data-lane-result={lane.state}
    >
      <MessageAuthorHeading>{`${verb} ${title}`}</MessageAuthorHeading>
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
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="shrink-0">{verb}</span>
          <LaneResultGlyph state={lane.state} />
          <span className="min-w-0 truncate">{title}</span>
        </span>
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
