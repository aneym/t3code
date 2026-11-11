import type { AgentAudience } from "@t3tools/client-runtime/agent-audience";

import type { TimelineEntry } from "../session-logic";
import { embedAgentAudience, useEmbedAgentMessagesShown } from "./embedAudience";
import { useEmbedHostConnected } from "./embedHost";
import { foldNoteRuns } from "./embedNoteRuns";
import { isEmbedLaunchBrief, isEmbedPersonMessage } from "./embedQuietMessages";
import { useEmbedSeenMark } from "./embedSeen";

const asPerson = new WeakMap<TimelineEntry, TimelineEntry>();
const NO_AUDIENCE: AgentAudience = { items: new Set(), runs: new Set() };

function personEntry(entry: TimelineEntry & { readonly kind: "message" }): TimelineEntry {
  const known = asPerson.get(entry);
  if (known !== undefined) return known;
  const mine: TimelineEntry = { ...entry, message: { ...entry.message, createdBy: "user" } };
  asPerson.set(entry, mine);
  return mine;
}

export type EmbedTimeline = {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly audience: AgentAudience;
  readonly agentsShown: boolean;
};

export function useEmbedTimeline(
  threadId: string | null,
  entries: ReadonlyArray<TimelineEntry>,
): EmbedTimeline {
  const embedThreadId = useEmbedHostConnected() ? threadId : null;
  const agentsShown = useEmbedAgentMessagesShown();
  useEmbedSeenMark(embedThreadId);
  if (embedThreadId === null) return { entries, audience: NO_AUDIENCE, agentsShown };
  const kept = entries.filter(
    (entry) => entry.kind !== "message" || !isEmbedLaunchBrief(entry.message, embedThreadId),
  );
  const audience = embedAgentAudience(kept, embedThreadId);
  const shown = kept.flatMap((entry) =>
    audience.items.has(entry.id)
      ? agentsShown
        ? [entry]
        : []
      : entry.kind === "message" && isEmbedPersonMessage(entry.message)
        ? [personEntry(entry)]
        : [entry],
  );
  const muted = agentsShown ? audience.items : NO_AUDIENCE.items;
  return { entries: foldNoteRuns(shown, muted), audience, agentsShown };
}
