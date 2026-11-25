import { RunId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

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

export function replyIds(
  entries: ReadonlyArray<TimelineEntry>,
  enabled: boolean | undefined,
): ReadonlySet<string> {
  if (enabled !== true) return NONE;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.message.role !== "assistant") continue;
    if (entry.message.streaming || entry.message.text.trim() === "") continue;
    ids.add(entry.id);
  }
  return ids;
}

interface TurnFoldShape {
  readonly runId: RunId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly entryIds: ReadonlySet<string>;
  readonly label: string;
}

interface FoldPart {
  readonly start: string;
  end?: string;
  readonly entries: TimelineEntry[];
  readonly hidden: Set<string>;
  readonly afterText: boolean;
}

const entryEnd = (entry: TimelineEntry) =>
  entry.kind === "message" ? entry.message.updatedAt : entry.createdAt;

const shownText = (entry: TimelineEntry) =>
  entry.kind === "message" &&
  entry.message.role === "assistant" &&
  entry.message.text.trim() !== "";

function partLabel(verb: string, part: FoldPart): string {
  const start = Date.parse(part.start);
  const ends = part.entries.map(entryEnd).concat(part.end ?? []);
  const end = Math.max(...ends.map((at) => Date.parse(at)));
  return Number.isFinite(start) && Number.isFinite(end)
    ? `${verb} for ${formatDuration(Math.max(0, end - start))}`
    : verb;
}

export function splitTurnFolds<Fold extends TurnFoldShape>(
  folds: ReadonlyMap<string, Fold>,
  inlineIds: ReadonlySet<string>,
  entries: ReadonlyArray<TimelineEntry>,
  enabled: boolean | undefined,
): ReadonlyMap<string, Fold> {
  if (enabled !== true) return folds;
  const foldByEntryId = new Map<string, Fold>();
  for (const fold of folds.values()) {
    for (const id of fold.entryIds) foldByEntryId.set(id, fold);
  }
  const state = new Map<
    Fold,
    { parts: FoldPart[]; open: FoldPart | null; start: string; seenText: boolean }
  >();
  for (const entry of entries) {
    const fold = foldByEntryId.get(entry.id);
    if (fold === undefined) continue;
    let at = state.get(fold);
    if (at === undefined) {
      at = { parts: [], open: null, start: fold.createdAt, seenText: false };
      state.set(fold, at);
    }
    if (fold.hiddenEntryIds.has(entry.id) && !inlineIds.has(entry.id)) {
      if (at.open === null) {
        at.open = {
          start: at.start,
          entries: [],
          hidden: new Set(),
          afterText: at.seenText,
        };
        at.parts.push(at.open);
      }
      at.open.entries.push(entry);
      at.open.hidden.add(entry.id);
    } else if (shownText(entry)) {
      if (at.open !== null) at.open.end = entry.createdAt;
      at.open = null;
      at.start = entryEnd(entry);
      at.seenText = true;
    } else {
      at.open?.entries.push(entry);
    }
  }
  const next = new Map<string, Fold>();
  for (const fold of folds.values()) {
    const parts = state.get(fold)?.parts ?? [];
    if (
      parts.length === 1 &&
      !parts[0]!.afterText &&
      parts[0]!.hidden.size === fold.hiddenEntryIds.size
    ) {
      next.set(fold.anchorEntryId, fold);
      continue;
    }
    for (const [index, part] of parts.entries()) {
      const anchorEntryId = part.afterText ? part.entries[0]!.id : fold.anchorEntryId;
      const verb = index === 0 ? fold.label.replace(/ (for|after) .*$/, "") : "Worked";
      next.set(anchorEntryId, {
        ...fold,
        runId: index === 0 ? fold.runId : RunId.make(`${fold.runId}:part:${anchorEntryId}`),
        anchorEntryId,
        createdAt: part.start,
        hiddenEntryIds: part.hidden,
        entryIds: new Set(part.entries.map((entry) => entry.id)),
        label: partLabel(verb, part),
      });
    }
  }
  return next;
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
