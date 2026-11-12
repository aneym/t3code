import type { TimelineEntry } from "../session-logic";
import type { ChatMessage } from "../types";

type MessageEntry = TimelineEntry & { readonly kind: "message" };

const runs = new WeakMap<ChatMessage, ReadonlyArray<ChatMessage>>();
const heads = new WeakMap<ChatMessage, { readonly size: number; readonly entry: MessageEntry }>();

const isNote = (entry: TimelineEntry | undefined): entry is MessageEntry =>
  entry?.kind === "message" && entry.message.quietNote === true;

export const noteRunOf = (message: ChatMessage): ReadonlyArray<ChatMessage> | null =>
  runs.get(message) ?? null;

function headOf(first: MessageEntry, run: ReadonlyArray<ChatMessage>): MessageEntry {
  const known = heads.get(first.message);
  if (known?.size === run.length) return known.entry;
  const entry: MessageEntry = { ...first, message: { ...first.message } };
  runs.set(entry.message, run);
  heads.set(first.message, { size: run.length, entry });
  return entry;
}

export function foldNoteRuns(
  entries: ReadonlyArray<TimelineEntry>,
  muted: ReadonlySet<string>,
): ReadonlyArray<TimelineEntry> {
  const out: TimelineEntry[] = [];
  let at = 0;
  while (at < entries.length) {
    const entry = entries[at]!;
    if (!isNote(entry)) {
      out.push(entry);
      at += 1;
      continue;
    }
    let end = at + 1;
    while (isNote(entries[end]) && muted.has(entries[end]!.id) === muted.has(entry.id)) end += 1;
    const run = entries.slice(at, end).map((e) => (e as MessageEntry).message);
    out.push(run.length < 2 ? entry : headOf(entry, run));
    at = end;
  }
  return out;
}
