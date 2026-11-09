import type { TimelineEntry } from "../session-logic";
import { useEmbedHostConnected } from "./embedHost";
import { isEmbedLaunchBrief, isEmbedPersonMessage } from "./embedQuietMessages";

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
  if (embedThreadId === null) return entries;
  return entries.flatMap((entry) =>
    entry.kind !== "message"
      ? [entry]
      : isEmbedLaunchBrief(entry.message, embedThreadId)
        ? []
        : isEmbedPersonMessage(entry.message)
          ? [personEntry(entry)]
          : [entry],
  );
}
