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
