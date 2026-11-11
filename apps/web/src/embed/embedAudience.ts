import {
  type AudienceItem,
  agentAudience,
  railsAskTo,
} from "@t3tools/client-runtime/agent-audience";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { TimelineEntry } from "../session-logic";

const STORAGE_KEY = "t3code:embed-agent-messages";

let shown = false;
const listeners = new Set<() => void>();

function stored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "shown";
  } catch {
    return false;
  }
}

export function startEmbedAudience(): void {
  shown = stored();
}

function keep(next: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "shown" : "hidden");
  } catch {
    return;
  }
}

export function applyEmbedAudienceMessage(message: { readonly shown: boolean }): void {
  keep(message.shown);
  if (shown === message.shown) return;
  shown = message.shown;
  for (const listener of listeners) listener();
}

export function useEmbedAgentMessagesShown(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown,
    () => false,
  );
}

function audienceItem(entry: TimelineEntry, inputs: ReadonlyMap<string, unknown>): AudienceItem {
  switch (entry.kind) {
    case "message":
      return { kind: "message", id: entry.id, message: entry.message };
    case "work":
      if (entry.entry.requestKind !== undefined || entry.entry.questionAnswer !== undefined) {
        return { kind: "request", id: entry.id };
      }
      if (entry.entry.itemType === "notification") {
        const notice = entry.entry.projectedItem?.item ?? entry.entry.structuredPayload;
        return {
          kind: "notice",
          id: entry.id,
          runId: entry.entry.runId ?? null,
          ...(notice?.type === "notification" && notice.source.kind === "system"
            ? { fromSystem: true as const }
            : {}),
        };
      }
      return { kind: "run", id: entry.id, runId: entry.entry.runId ?? null };
    case "proposed-plan":
      return { kind: "run", id: entry.id, runId: entry.proposedPlan.runId };
    case "html-render":
      return { kind: "run", id: entry.id, runId: entry.runId };
    case "mcp-app":
      return {
        kind: "ask",
        id: entry.id,
        runId: entry.runId,
        to: railsAskTo(entry.mcpApp, inputs.get(entry.id)),
      };
    case "event":
      return { kind: "run", id: entry.id, runId: entry.projectedItem.item.runId ?? null };
  }
}

function toolInputs(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyMap<string, unknown> {
  return new Map(
    items.flatMap(({ item }) => (item.type === "dynamic_tool" ? [[item.id, item.input]] : [])),
  );
}

export function embedAgentAudience(
  entries: ReadonlyArray<TimelineEntry>,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  threadId: string,
) {
  const inputs = toolInputs(items);
  return agentAudience(
    entries.map((entry) => audienceItem(entry, inputs)),
    threadId,
  );
}

const ROW_PREFIXES = ["", "work-live:", "work-toggle:", "summary:", "assistant-meta:"];

export function mutedRowsCss(
  entries: ReadonlySet<string>,
  runs: ReadonlySet<string>,
  liveRunId: string | null,
): string {
  const rows = [
    ...[...entries].flatMap((id) => ROW_PREFIXES.map((prefix) => `${prefix}${id}`)),
    ...[...runs].map((runId) => `turn-fold:${runId}`),
    ...(liveRunId !== null && runs.has(liveRunId) ? ["working-indicator-row"] : []),
  ];
  if (rows.length === 0) return "";
  const selectors = rows.map((row) => `[data-timeline-row-id="${CSS.escape(row)}"]`);
  return `[data-embed-audience] :is(${selectors.join(",")}){opacity:0.6}`;
}
