import type { RunId } from "@t3tools/contracts";
import type { MaintainScrollAtEndOptions } from "@legendapp/list/react";
import type { TimelineEntry } from "../../session-logic";

export const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    footerLayout: false,
    itemLayout: true,
    layout: true,
  },
} as const satisfies MaintainScrollAtEndOptions;
export const TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH = {
  ...TIMELINE_MAINTAIN_SCROLL_AT_END,
  animated: true,
} as const satisfies MaintainScrollAtEndOptions;

export function hasRunMcpApp(entries: ReadonlyArray<TimelineEntry>, runId: RunId | null) {
  return (
    runId !== null && entries.some((entry) => entry.kind === "mcp-app" && entry.runId === runId)
  );
}

export function isGrowingMcpApp(info: {
  itemData: { kind: string };
  size: number;
  previous: number;
}) {
  return info.itemData.kind === "mcp-app" && info.size > info.previous;
}
