import {
  EmbedRouteMessage,
  EmbedWarmMessage,
  type EmbedRouteRefusal,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const readEmbedRouteMessage = Schema.decodeUnknownOption(EmbedRouteMessage);
export const readEmbedWarmMessage = Schema.decodeUnknownOption(EmbedWarmMessage);

export type EmbedThreadVisibility = (thread: string) => boolean;

export function embedThreadVisibility(
  snapshot: Option.Option<OrchestrationV2ShellSnapshot>,
): EmbedThreadVisibility | null {
  if (Option.isNone(snapshot)) return null;
  const { threads, archivedThreads, olderSettled } = snapshot.value;
  if (olderSettled !== undefined) return () => true;
  const listed = new Set<string>();
  for (const thread of threads) listed.add(thread.id);
  for (const thread of archivedThreads) listed.add(thread.id);
  return (thread) => listed.has(thread);
}

export type EmbedRoutePlan =
  | { readonly kind: "same" }
  | { readonly kind: "navigate" }
  | { readonly kind: "refused"; readonly reason: EmbedRouteRefusal };

export function planEmbedRoute(
  thread: string,
  current: string | null,
  visible: EmbedThreadVisibility | null,
): EmbedRoutePlan {
  if (thread === current) return { kind: "same" };
  if (visible === null) return { kind: "refused", reason: "not-synced" };
  return visible(thread) ? { kind: "navigate" } : { kind: "refused", reason: "not-visible" };
}
