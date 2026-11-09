import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";

import type { ChatMessage } from "../types";

export type EmbedQuietLine =
  | { readonly kind: "agent"; readonly summary: string }
  | { readonly kind: "event"; readonly summary: string };

const MCP_EVENT_HEAD = /^MCP event `([^`]{1,80})` from ([^\s(]{1,120})/;

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

export function embedQuietLine(message: ChatMessage): EmbedQuietLine | null {
  if (message.role !== "user") return null;
  if (message.createdBy === "system") {
    const event = MCP_EVENT_HEAD.exec(message.text);
    return {
      kind: "event",
      summary: event ? `${event[1]} from ${event[2]}` : firstLine(message.text),
    };
  }
  const attribution = resolveUserMessagePresentation(message).attribution;
  if (attribution === "t3code") return { kind: "event", summary: firstLine(message.text) };
  return attribution === "agent" ? { kind: "agent", summary: firstLine(message.text) } : null;
}
