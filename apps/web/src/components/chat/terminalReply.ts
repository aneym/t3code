import type { MessageId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";

type MessageEntry = Extract<TimelineEntry, { kind: "message" }>;

const NONE: ReadonlyMap<MessageId, MessageId> = new Map();

function assistantResponses(entries: ReadonlyArray<TimelineEntry>): Array<Array<MessageEntry>> {
  const responses = new Map<string, Array<MessageEntry>>();
  let promptIndex = 0;
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const { message } = entry;
    if (message.role === "user") {
      promptIndex += 1;
      continue;
    }
    if (message.role !== "assistant") continue;
    const key = message.runId ? `turn:${message.runId}` : `unkeyed:${promptIndex}`;
    const response = responses.get(key);
    if (response === undefined) responses.set(key, [entry]);
    else response.push(entry);
  }
  return [...responses.values()];
}

export function terminalAssistantMessageIds(
  entries: ReadonlyArray<TimelineEntry>,
  blankReplies: ReadonlyMap<MessageId, MessageId> = NONE,
): ReadonlySet<MessageId> {
  return new Set(
    assistantResponses(entries).flatMap(
      (response) =>
        response.findLast(({ message }) => !blankReplies.has(message.id))?.message.id ?? [],
    ),
  );
}

const isBlankReply = ({ message }: MessageEntry) =>
  !message.streaming && message.text.trim() === "" && (message.attachments?.length ?? 0) === 0;

export function blankReplyTargets(
  entries: ReadonlyArray<TimelineEntry>,
  enabled: boolean | undefined,
): ReadonlyMap<MessageId, MessageId> {
  if (enabled !== true) return NONE;
  const targets = new Map<MessageId, MessageId>();
  for (const response of assistantResponses(entries)) {
    const reply = response.findLast((entry) => !isBlankReply(entry));
    if (reply === undefined) continue;
    for (const entry of response) {
      if (isBlankReply(entry)) targets.set(entry.message.id, reply.message.id);
    }
  }
  return targets;
}
