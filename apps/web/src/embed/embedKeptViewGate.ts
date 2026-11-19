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
  readonly sessionListsThread: boolean;
  readonly sessionChild?: boolean;
}

export function embedSessionListsThread(
  threadId: string,
  liveConfig: Pick<ServerConfig, "chatSession"> | null,
  sessionListsThread: boolean,
): boolean {
  return liveConfig === null
    ? sessionListsThread
    : (liveConfig.chatSession?.threadIds ?? []).some((id) => id === threadId);
}

export function embedKeptView(input: EmbedKeptViewInput): EmbedKeptView {
  if (!input.hasData || input.status === "live" || input.status === "deleted") return "live";
  if (!input.chatSession) return "kept";
  return input.sessionChild === true ||
    embedSessionListsThread(input.threadId, input.liveConfig, input.sessionListsThread)
    ? "kept"
    : "hold";
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
