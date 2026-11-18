import {
  AuthChatThreadsScope,
  CHAT_SESSION_METHODS,
  EnvironmentAuthorizationError,
  type ThreadId,
  authScopeRequiredResponse,
  isChatSessionScopes,
} from "@t3tools/contracts";

export type ChatThreadControls = "full" | "owner" | "seat";

let active = false;
let ownerThreadIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function noteChatSessionScopes(scopes: ReadonlyArray<string> | undefined): void {
  const next = isChatSessionScopes(scopes);
  if (next === active) return;
  active = next;
  notify();
}

export function noteChatSessionOwners(ids: ReadonlyArray<ThreadId> | undefined): void {
  const next = new Set<string>(ids ?? []);
  if (next.size === ownerThreadIds.size && [...next].every((id) => ownerThreadIds.has(id))) return;
  ownerThreadIds = next;
  notify();
}

export function chatThreadControls(threadId: string | null | undefined): ChatThreadControls {
  if (!active) return "full";
  return threadId && ownerThreadIds.has(threadId) ? "owner" : "seat";
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
