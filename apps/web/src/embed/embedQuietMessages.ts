import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { mcpEventOfMessage } from "@t3tools/contracts";

import { mcpEventLabel } from "../mcpEventMessage";
import type { ChatMessage } from "../types";

export type EmbedQuietLine =
  | { readonly kind: "agent"; readonly summary: string; readonly from?: string }
  | { readonly kind: "event"; readonly summary: string }
  | { readonly kind: "note"; readonly summary: string };

const HANDOFF_HEAD = /^Handed over from ([^\n]{1,80}?)\. The person asked /;
const HANDOFF_BODY = /\nWhat was handed over:\r?\n([\s\S]*)$/;

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

export function isEmbedLaunchBrief(message: ChatMessage, threadId: string): boolean {
  return (
    message.role === "user" &&
    message.createdBy === "agent" &&
    message.senderThreadId === undefined &&
    message.id === threadId
  );
}

type SentMessage = Parameters<typeof resolveUserMessagePresentation>[0] &
  Pick<ChatMessage, "senderThreadId"> & { readonly quietNote?: true | undefined };

export function isEmbedPersonMessage(message: SentMessage): boolean {
  return (
    message.role === "user" &&
    message.quietNote !== true &&
    message.createdBy === "agent" &&
    message.creationSource === "mcp" &&
    message.senderThreadId === undefined &&
    resolveUserMessagePresentation(message).attribution === "agent" &&
    !HANDOFF_HEAD.test(message.text)
  );
}

export function embedQuietLine(message: ChatMessage): EmbedQuietLine | null {
  if (message.role !== "user") return null;
  if (message.quietNote === true) return { kind: "note", summary: firstLine(message.text) };
  if (message.createdBy === "system") {
    const event = mcpEventOfMessage(message);
    return { kind: "event", summary: event ? mcpEventLabel(event) : firstLine(message.text) };
  }
  const attribution = resolveUserMessagePresentation(message).attribution;
  if (attribution === "t3code") return { kind: "event", summary: firstLine(message.text) };
  if (attribution !== "agent" || isEmbedPersonMessage(message)) return null;
  const from = HANDOFF_HEAD.exec(message.text)?.[1];
  if (from === undefined) return { kind: "agent", summary: firstLine(message.text) };
  return { kind: "agent", from, summary: firstLine(HANDOFF_BODY.exec(message.text)?.[1] ?? "") };
}
