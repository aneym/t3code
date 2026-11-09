import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";
import { useEmbedHostConnected } from "./embedHost";

const SHOWN = new Set<MessagesTimelineRow["kind"]>([
  "proposed-plan",
  "html-render",
  "mcp-app",
  "event",
  "context-compaction",
  "worktree-setup",
]);

const asksPerson = (row: MessagesTimelineRow) =>
  (row.kind === "work" ? row.groupedEntries : row.kind === "work-live" ? [row.entry] : []).some(
    (entry) => entry.projectedItem?.item.type === "approval_request",
  );

const isActivity = (row: MessagesTimelineRow) =>
  row.kind === "work-live" || row.kind === "thinking";

export function useLiveTurnFold(
  rows: MessagesTimelineRow[],
  isWorking: boolean,
): MessagesTimelineRow[] {
  const embedded = useEmbedHostConnected();
  if (!embedded || !isWorking) return rows;
  const header = rows.findIndex((row) => row.kind === "working");
  if (header < 0) return rows;
  const turn = rows.slice(header + 1);
  const activity = turn.findLastIndex(isActivity);
  const kept = turn.filter(
    (row, index) =>
      index === activity ||
      SHOWN.has(row.kind) ||
      asksPerson(row) ||
      (row.kind === "message" && row.message.role === "user"),
  );
  return kept.length === turn.length ? rows : [...rows.slice(0, header + 1), ...kept];
}
