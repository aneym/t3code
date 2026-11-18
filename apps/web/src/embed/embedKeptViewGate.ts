import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import type { ServerConfig } from "@t3tools/contracts";

export type EmbedKeptView = "live" | "kept" | "hold";

export interface EmbedKeptViewInput {
  readonly threadId: string;
  readonly status: EnvironmentThreadStatus;
  readonly hasData: boolean;
  readonly chatSession: boolean;
  readonly liveConfig: Pick<ServerConfig, "chatSession"> | null;
}

export function embedKeptView(input: EmbedKeptViewInput): EmbedKeptView {
  if (!input.hasData || input.status === "live" || input.status === "deleted") return "live";
  if (!input.chatSession) return "kept";
  const threadIds = input.liveConfig?.chatSession?.threadIds ?? [];
  return threadIds.some((id) => id === input.threadId) ? "kept" : "hold";
}

export function embedConnectionRefused(
  state: Pick<SupervisorConnectionState, "phase" | "lastFailure">,
): boolean {
  return (
    state.phase === "blocked" &&
    state.lastFailure?._tag === "ConnectionBlockedError" &&
    (state.lastFailure.reason === "authentication" || state.lastFailure.reason === "permission")
  );
}
