import type { HostLinkEventKind, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MAX_MESSAGE_TEXT = 16_000;
const MAX_TRACKED_RUNS = 2_000;
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const QUIET_ITEM_TYPES = new Set(["user_message", "assistant_message", "reasoning"]);
const ENDED_BY_TYPE: Readonly<Record<string, string>> = {
  "thread.settled": "settled",
  "thread.archived": "archived",
  "thread.deleted": "deleted",
};
const REOPENED_BY_TYPE: Readonly<Record<string, string>> = {
  "thread.unsettled": "unsettled",
  "thread.unarchived": "unarchived",
};

export interface HostLinkThreadEvent {
  readonly threadId: string;
  readonly kind: HostLinkEventKind;
  readonly at: string;
  readonly data: Record<string, unknown>;
  readonly coalesceKey: string | null;
}

const clip = (text: string) =>
  text.length > MAX_MESSAGE_TEXT
    ? { text: text.slice(0, MAX_MESSAGE_TEXT), truncated: true }
    : { text, truncated: false };

export const makeHostLinkEventMapper = () => {
  const reported = new Map<string, Set<"started" | "done">>();
  const markRun = (runId: string, kind: "started" | "done") => {
    const seen = reported.get(runId) ?? new Set();
    if (seen.has(kind)) return false;
    seen.add(kind);
    reported.delete(runId);
    reported.set(runId, seen);
    if (reported.size > MAX_TRACKED_RUNS) {
      const oldest = reported.keys().next().value;
      if (oldest !== undefined) reported.delete(oldest);
    }
    return true;
  };

  return (event: OrchestrationV2DomainEvent): HostLinkThreadEvent | null => {
    const threadId = event.threadId;
    const at = DateTime.formatIso(event.occurredAt);
    const make = (
      kind: HostLinkEventKind,
      data: Record<string, unknown>,
      coalesceKey: string | null = null,
    ): HostLinkThreadEvent => ({ threadId, kind, at, data, coalesceKey });
    switch (event.type) {
      case "run.created":
      case "run.updated": {
        const run = event.payload;
        if (run.status === "running" && markRun(run.id, "started"))
          return make("started", { runId: run.id, ordinal: run.ordinal });
        if (TERMINAL_RUN_STATUSES.has(run.status) && markRun(run.id, "done"))
          return make("done", { runId: run.id, ordinal: run.ordinal, status: run.status });
        return null;
      }
      case "message.updated": {
        const message = event.payload;
        return make(
          "message",
          {
            messageId: message.id,
            role: message.role,
            ...clip(message.text),
            streaming: message.streaming,
            runId: message.runId,
          },
          message.streaming ? `message:${message.id}` : null,
        );
      }
      case "turn-item.updated": {
        const item = event.payload;
        if (QUIET_ITEM_TYPES.has(item.type)) return null;
        return make(
          "step",
          {
            itemId: item.id,
            itemType: item.type,
            status: item.status,
            title: item.title,
            runId: item.runId,
          },
          item.status === "running" ? `step:${item.id}` : null,
        );
      }
      default: {
        const ended = ENDED_BY_TYPE[event.type];
        if (ended !== undefined) return make("ended", { reason: ended });
        const reopened = REOPENED_BY_TYPE[event.type];
        if (reopened !== undefined) return make("reopened", { reason: reopened });
        return null;
      }
    }
  };
};
