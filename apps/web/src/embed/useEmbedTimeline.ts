import { useEffect } from "react";

import type { MessagesTimelineHistoryControls } from "../components/chat/MessagesTimeline";
import type { TimelineEntry } from "../session-logic";
import {
  afterClear,
  showEarlierInEmbed,
  trackEmbedTimeline,
  useEmbedClearView,
} from "./embedClearView";
import { useEmbedHostConnected } from "./embedHost";
import { isEmbedLaunchBrief } from "./embedQuietMessages";

const SHOW_EARLIER: MessagesTimelineHistoryControls = {
  hasMoreHistory: true,
  loading: false,
  error: null,
  label: "Show earlier",
  onLoadEarlier: showEarlierInEmbed,
};

export function useEmbedTimeline(
  threadId: string | null,
  entries: ReadonlyArray<TimelineEntry>,
  historyControls: MessagesTimelineHistoryControls | undefined,
): {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly historyControls: MessagesTimelineHistoryControls | undefined;
} {
  const embedThreadId = useEmbedHostConnected() ? threadId : null;
  const view = useEmbedClearView(embedThreadId);
  const unbriefed =
    embedThreadId === null
      ? entries
      : entries.filter(
          (entry) => entry.kind !== "message" || !isEmbedLaunchBrief(entry.message, embedThreadId),
        );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the shown timeline to the module store that a /clear or host key reads outside React
  useEffect(() => {
    if (embedThreadId !== null) trackEmbedTimeline(embedThreadId, unbriefed);
  }, [embedThreadId, unbriefed]);
  if (view.marker === null || view.showEarlier) return { entries: unbriefed, historyControls };
  const shown = afterClear(unbriefed, view.marker);
  return shown.length === unbriefed.length
    ? { entries: shown, historyControls }
    : { entries: shown, historyControls: SHOW_EARLIER };
}
