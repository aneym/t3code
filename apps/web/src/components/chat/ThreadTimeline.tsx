import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ComponentProps, useLayoutEffect } from "react";
import { embedLiveRunId, useEmbedClearedEntries } from "../../embed/embedClear";
import { isEmbedPath } from "../../embed/embedProtocol";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { TimelineEntriesInput, TimelineEntry } from "../../session-logic";
import { useTimelineVisibleTurnItems } from "../../state/entities";
import {
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
} from "../ChatView.logic";
import { useEmbedTimeline } from "../../embed/useEmbedTimeline";
import { EmbedShowEarlier } from "../embed/EmbedShowEarlier";
import { MessagesTimeline } from "./MessagesTimeline";

/**
 * The timeline with the streamed text. ChatView reads the thread through its quiet
 * atoms, which hold through text deltas; this reads the live turn items, so a
 * reasoning delta re-renders the timeline without re-rendering ChatView. Streamed
 * assistant text reaches only its own row, through useAssistantMessageText.
 */
export function ThreadTimeline({
  threadDetailRef,
  entriesInput,
  draftEntries,
  activeThreadKey,
  syncing,
  detailLoading,
  ...timelineProps
}: Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries"> & {
  /** Null until the thread's detail may load; see resolveThreadDetailRef. */
  threadDetailRef: ScopedThreadRef | null;
  entriesInput: Omit<TimelineEntriesInput, "visibleTurnItems">;
  /** A local draft's optimistic rows; null for a server thread. */
  draftEntries: ReadonlyArray<TimelineEntry> | null;
  activeThreadKey: string | null;
  syncing: boolean;
  detailLoading: boolean;
}) {
  const visibleTurnItems = useTimelineVisibleTurnItems(threadDetailRef);
  const serverEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...entriesInput,
    visibleTurnItems,
  });
  const entries = draftEntries ?? serverEntries;
  const displayedEntries = resolveThreadSwitchTimeline({
    loading: entries.length === 0 && syncing,
    activeThreadKey,
    nextEntries: entries,
    rememberedForActive: peekRememberedThreadTimeline<typeof entries>(activeThreadKey),
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stores the committed ready timeline in the module-level cache used during thread switches
  useLayoutEffect(() => {
    if (detailLoading || entries.length === 0 || timelineHasEphemeralPreviewUrls(entries)) {
      return;
    }
    rememberReadyThreadTimeline({ threadKey: activeThreadKey, entries });
  }, [activeThreadKey, detailLoading, entries]);
  const embedPage = isEmbedPath(window.location.pathname);
  const embedEntries = useEmbedTimeline(threadDetailRef?.threadId ?? null, displayedEntries);
  const cleared = useEmbedClearedEntries(
    embedEntries,
    embedLiveRunId(timelineProps.runningRunId ?? null, timelineProps.latestRun),
    embedPage,
  );
  const timeline = (
    <MessagesTimeline
      {...timelineProps}
      hideEmptyPlaceholder={timelineProps.hideEmptyPlaceholder === true || cleared.hidden > 0}
      timelineEntries={cleared.shown}
    />
  );
  if (!embedPage) return timeline;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EmbedShowEarlier hidden={cleared.hidden} />
      <div className="relative min-h-0 flex-1">{timeline}</div>
    </div>
  );
}
