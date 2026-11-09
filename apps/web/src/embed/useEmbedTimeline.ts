import type { TimelineEntry } from "../session-logic";
import { useEmbedHostConnected } from "./embedHost";
import { isEmbedLaunchBrief } from "./embedQuietMessages";

export function useEmbedTimeline(
  threadId: string | null,
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TimelineEntry> {
  const embedThreadId = useEmbedHostConnected() ? threadId : null;
  if (embedThreadId === null) return entries;
  return entries.filter(
    (entry) => entry.kind !== "message" || !isEmbedLaunchBrief(entry.message, embedThreadId),
  );
}
