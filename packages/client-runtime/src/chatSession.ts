import {
  AuthChatThreadsScope,
  CHAT_SESSION_METHODS,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  isChatSessionScopes,
} from "@t3tools/contracts";

let active = false;
const listeners = new Set<() => void>();

export function noteChatSessionScopes(scopes: ReadonlyArray<string> | undefined): void {
  const next = isChatSessionScopes(scopes);
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener();
}

export function chatSessionActive(): boolean {
  return active;
}

export function subscribeChatSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function chatSessionAllows(method: string): boolean {
  return !active || CHAT_SESSION_METHODS.has(method);
}

export function chatSessionRefusal(method: string): EnvironmentAuthorizationError {
  return new EnvironmentAuthorizationError({
    ...authScopeRequiredResponse(AuthChatThreadsScope),
    message: `A chat session cannot call ${method}.`,
  });
}
