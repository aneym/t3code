import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";
import { useClientSettings } from "../hooks/useSettings";
import { useEmbedHostConnected } from "./embedHost";
import { useEmbedLivePeek } from "./embedLivePeek";

const SHOWN = new Set<MessagesTimelineRow["kind"]>([
  "proposed-plan",
  "html-render",
  "mcp-app",
  "event",
  "context-compaction",
  "worktree-setup",
]);

const STEPS = new Set<MessagesTimelineRow["kind"]>(["work", "work-live", "work-toggle"]);

const asksPerson = (row: MessagesTimelineRow) =>
  (row.kind === "work" ? row.groupedEntries : row.kind === "work-live" ? [row.entry] : []).some(
    (entry) => entry.projectedItem?.item.type === "approval_request",
  );

function liveAnswerIndex(turn: ReadonlyArray<MessagesTimelineRow>): number {
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const row = turn[index]!;
    if (STEPS.has(row.kind)) return -1;
    if (row.kind === "message" && row.message.role === "assistant") return index;
  }
  return -1;
}

function openingReplyRows(turn: ReadonlyArray<MessagesTimelineRow>): ReadonlySet<number> {
  const kept = new Set<number>();
  let open = true;
  for (const [index, row] of turn.entries()) {
    if (row.kind === "message" && row.message.role === "user") {
      open = true;
    } else if (STEPS.has(row.kind)) {
      open = false;
    } else if (open && row.kind === "message" && row.message.role === "assistant") {
      if (!row.message.streaming && row.message.text.trim() !== "") kept.add(index);
      open = row.message.text.trim() === "";
    }
  }
  return kept;
}

export function useLiveTurnFold(
  rows: MessagesTimelineRow[],
  isWorking: boolean,
): MessagesTimelineRow[] {
  const embedded = useEmbedHostConnected();
  const peeked = useEmbedLivePeek();
  const keepOpening = useClientSettings((settings) => settings.keepOpeningReplyVisible);
  if (!embedded || !isWorking) return rows;
  const header = rows.findIndex((row) => row.kind === "working");
  if (header < 0) return rows;
  const working = rows[header];
  if (working?.kind === "working" && working.createdAt && working.createdAt === peeked) return rows;
  const turn = rows.slice(header + 1);
  const answer = liveAnswerIndex(turn);
  const opening = keepOpening ? openingReplyRows(turn) : new Set<number>();
  const kept = turn.filter(
    (row, index) =>
      index === answer ||
      opening.has(index) ||
      SHOWN.has(row.kind) ||
      asksPerson(row) ||
      (row.kind === "message" && (row.message.role === "user" || row.message.streaming)),
  );
  return kept.length === turn.length ? rows : [...rows.slice(0, header + 1), ...kept];
}
