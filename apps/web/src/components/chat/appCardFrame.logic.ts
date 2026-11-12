import {
  MCP_APP_CARD_HOST_TOKEN,
  MCP_APP_CARD_PATH,
  mcpAppCardFromToolItem,
  type McpAppCardReference,
} from "@t3tools/shared/mcpAppCard";
import * as Predicate from "effect/Predicate";

import type { TimelineEntry } from "../../session-logic";

export const APP_CARD_READY_TIMEOUT_MS = 8_000;

export type AppCardReadyState = "app" | "unavailable";

export function appCardHostSupported(userAgent: string): boolean {
  return userAgent.includes(MCP_APP_CARD_HOST_TOKEN);
}

function allowedOriginSet(origins: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(
    origins.flatMap((origin) => (URL.canParse(origin) ? [new URL(origin).origin] : [])),
  );
}

function allowedCardOrigin(card: string, allowed: ReadonlySet<string>): string | null {
  if (!URL.canParse(card)) return null;
  const url = new URL(card);
  return allowed.has(url.origin) && url.pathname === MCP_APP_CARD_PATH ? url.origin : null;
}

export function appCardFrameSource(card: string, theme: "light" | "dark"): string {
  const url = new URL(card);
  url.searchParams.set("theme", theme);
  return url.href;
}

export function readAppCardReadyState(data: unknown): AppCardReadyState | null {
  if (
    !Predicate.isObject(data) ||
    data.source !== "rails-app-card" ||
    data.type !== "ready" ||
    data.v !== 1
  ) {
    return null;
  }
  return data.state === "app" || data.state === "unavailable" ? data.state : null;
}

function appCardPairKey(card: McpAppCardReference): string {
  return card.lane === undefined && card.server === undefined
    ? card.card
    : JSON.stringify([card.lane ?? null, card.server ?? null]);
}

export function withAppCardEntries(
  entries: ReadonlyArray<TimelineEntry>,
  allowedOrigins: ReadonlyArray<string>,
): ReadonlyArray<TimelineEntry> {
  const allowed = allowedOriginSet(allowedOrigins);
  const cardsByEntryId = new Map<string, McpAppCardReference>();
  const newestEntryIdByPair = new Map<string, string>();
  for (const entry of entries) {
    const item = entry.kind === "work" ? entry.entry.structuredPayload : undefined;
    const card = item === undefined ? undefined : mcpAppCardFromToolItem(item);
    if (card === undefined || allowedCardOrigin(card.card, allowed) === null) continue;
    cardsByEntryId.set(entry.id, card);
    newestEntryIdByPair.set(appCardPairKey(card), entry.id);
  }
  if (newestEntryIdByPair.size === 0) return entries;
  const newest = new Set(newestEntryIdByPair.values());
  return entries.flatMap((entry): TimelineEntry[] => {
    const card = newest.has(entry.id) ? cardsByEntryId.get(entry.id) : undefined;
    if (card === undefined || entry.kind !== "work") return [entry];
    return [
      entry,
      {
        id: `app-card:${entry.id}`,
        kind: "app-card",
        createdAt: entry.createdAt,
        runId: entry.entry.runId ?? null,
        card,
        ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
      },
    ];
  });
}
