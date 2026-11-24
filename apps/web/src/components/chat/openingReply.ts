import type { TimelineEntry } from "../../session-logic";

const NONE: ReadonlySet<string> = new Set();

export function timelineEntryIsSteer(entry: TimelineEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.message.role === "user" &&
    (entry.message.inputIntent === "steer" ||
      entry.message.inputIntent === "promoted_queued_to_steer")
  );
}

export function timelineEntryStartsResponse(entry: TimelineEntry): boolean {
  return (
    (entry.kind === "message" && entry.message.role === "user" && !timelineEntryIsSteer(entry)) ||
    (entry.kind === "work" && entry.entry.itemType === "notification")
  );
}

function entryStartsWork(entry: TimelineEntry): boolean {
  if (entry.kind === "work") {
    const { itemType, sourceActivityKind } = entry.entry;
    return (
      itemType !== "reasoning" &&
      itemType !== "system_notice" &&
      sourceActivityKind !== "context-compaction"
    );
  }
  if (entry.kind === "event") return entry.projectedItem.item.type === "subagent";
  return entry.kind !== "message";
}

export function replyIds(
  entries: ReadonlyArray<TimelineEntry>,
  enabled: boolean | undefined,
): ReadonlySet<string> {
  if (enabled !== true) return NONE;
  const ids = new Set<string>();
  let open = false;
  let runId: string | undefined;
  let attemptId: string | undefined;
  for (const entry of entries) {
    if (
      (entry.kind === "message" && entry.message.role === "user") ||
      timelineEntryStartsResponse(entry)
    ) {
      open = true;
      runId = undefined;
      attemptId = undefined;
      continue;
    }
    const entryRunId =
      entry.kind === "message"
        ? entry.message.runId
        : entry.kind === "work"
          ? entry.entry.runId
          : null;
    if (entryRunId != null && entryRunId !== runId) {
      open = true;
      runId = entryRunId;
      attemptId = undefined;
    }
    if (entry.attempt !== undefined && entry.attempt.id !== attemptId) {
      if (attemptId !== undefined) open = true;
      attemptId = entry.attempt.id;
    }
    if (!open) continue;
    if (entry.kind === "message" && entry.message.role === "assistant") {
      if (entry.message.streaming) {
        open = false;
      } else if (entry.message.text.trim() !== "") {
        ids.add(entry.id);
        open = false;
      }
      continue;
    }
    if (entryStartsWork(entry)) open = false;
  }
  return ids;
}

export function unfoldReplies<
  Fold extends {
    readonly anchorEntryId: string;
    readonly hiddenEntryIds: ReadonlySet<string>;
  },
>(
  folds: ReadonlyMap<string, Fold>,
  openingIds: ReadonlySet<string>,
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<string, Fold> {
  if (openingIds.size === 0) return folds;
  const openingIndexById = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (openingIds.has(entry.id)) openingIndexById.set(entry.id, index);
  }
  const next = new Map<string, Fold>();
  for (const fold of folds.values()) {
    let openingIndex = -1;
    for (const id of fold.hiddenEntryIds) {
      const index = openingIndexById.get(id);
      if (index !== undefined && (openingIndex < 0 || index < openingIndex)) openingIndex = index;
    }
    if (openingIndex < 0) {
      next.set(fold.anchorEntryId, fold);
      continue;
    }
    const hiddenEntryIds = new Set([...fold.hiddenEntryIds].filter((id) => !openingIds.has(id)));
    if (hiddenEntryIds.size === 0) continue;
    const anchorEntryId = entries[openingIndex + 1]?.id ?? fold.anchorEntryId;
    next.set(anchorEntryId, { ...fold, anchorEntryId, hiddenEntryIds });
  }
  return next;
}
