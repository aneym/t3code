import type { TimelineEntry } from "../session-logic";
import { useEmbedHostConnected } from "./embedHost";
import { foldNoteRuns } from "./embedNoteRuns";
import { isEmbedLaunchBrief, isEmbedPersonMessage } from "./embedQuietMessages";
import { useEmbedSeenMark } from "./embedSeen";

const asPerson = new WeakMap<TimelineEntry, TimelineEntry>();

function personEntry(entry: TimelineEntry & { readonly kind: "message" }): TimelineEntry {
  const known = asPerson.get(entry);
  if (known !== undefined) return known;
  const mine: TimelineEntry = { ...entry, message: { ...entry.message, createdBy: "user" } };
  asPerson.set(entry, mine);
  return mine;
}

export function useEmbedTimeline(
  threadId: string | null,
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TimelineEntry> {
  const embedThreadId = useEmbedHostConnected() ? threadId : null;
  useEmbedSeenMark(embedThreadId);
  if (embedThreadId === null) return entries;
  const shown = entries.flatMap((entry) =>
    entry.kind !== "message"
      ? [entry]
      : isEmbedLaunchBrief(entry.message, embedThreadId)
        ? []
        : isEmbedPersonMessage(entry.message)
          ? [personEntry(entry)]
          : [entry],
  );
  return foldNoteRuns(shown);
}
