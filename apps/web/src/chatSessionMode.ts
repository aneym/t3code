import type { AuthSessionState } from "@t3tools/contracts";
import {
  chatSessionActive,
  noteChatSessionScopes,
  subscribeChatSession,
} from "@t3tools/client-runtime/chat-session";
import { useSyncExternalStore } from "react";

export function applyChatSessionState(state: AuthSessionState): void {
  noteChatSessionScopes(state.authenticated ? (state.permissions ?? state.scopes) : undefined);
  if (typeof document === "undefined") return;
  if (chatSessionActive()) document.documentElement.dataset.chatSession = "true";
  else delete document.documentElement.dataset.chatSession;
}

export function useChatSession(): boolean {
  return useSyncExternalStore(subscribeChatSession, chatSessionActive, () => false);
}
