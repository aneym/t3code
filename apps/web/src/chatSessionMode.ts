import type { AuthSessionState } from "@t3tools/contracts";
import {
  chatSessionActive,
  chatSessionListsThread,
  chatThreadControls,
  noteChatSessionScopes,
  noteChatSessionThreads,
  subscribeChatSession,
  type ChatThreadControls,
} from "@t3tools/client-runtime/chat-session";
import { useSyncExternalStore } from "react";

export function applyChatSessionState(state: AuthSessionState): void {
  noteChatSessionScopes(state.authenticated ? (state.permissions ?? state.scopes) : undefined);
  noteChatSessionThreads(state.authenticated ? state.chatThreadIds : undefined);
}

export function useChatSession(): boolean {
  return useSyncExternalStore(subscribeChatSession, chatSessionActive, () => false);
}

export function useChatThreadControls(threadId: string | null | undefined): ChatThreadControls {
  return useSyncExternalStore(
    subscribeChatSession,
    () => chatThreadControls(threadId),
    () => "full",
  );
}

export function useChatSessionListsThread(threadId: string | null): boolean {
  return useSyncExternalStore(
    subscribeChatSession,
    () => threadId !== null && chatSessionListsThread(threadId),
    () => false,
  );
}

export const ANSWER_ONLY_REASON = "Run by its parent agent";

export function useComposerSendGate(canOperateThread: boolean, threadId: string): string | null {
  const controls = useChatThreadControls(threadId);
  if (!canOperateThread) return "This connection cannot change threads.";
  return controls === "answer" ? ANSWER_ONLY_REASON : null;
}
