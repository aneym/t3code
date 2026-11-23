import {
  AuthChatThreadsScope,
  CHAT_SESSION_METHODS,
  EnvironmentAuthorizationError,
  type ThreadId,
  authScopeRequiredResponse,
  isChatSessionScopes,
} from "@t3tools/contracts";

export type ChatThreadControls = "full" | "owner" | "seat" | "unavailable" | "answer";

let active = false;
let ownerThreadIds: ReadonlySet<string> = new Set();
let ownerPolicy = false;
let sessionThreadIds: ReadonlySet<string> = new Set();
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

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

export function noteChatSessionOwners(
  view:
    | { readonly ownerThreadIds: ReadonlyArray<ThreadId>; readonly ownerPolicy?: boolean }
    | undefined,
): void {
  const next = new Set<string>(view?.ownerThreadIds ?? []);
  const nextPolicy = view?.ownerPolicy === true || next.size > 0;
  if (sameIds(next, ownerThreadIds) && nextPolicy === ownerPolicy) return;
  ownerThreadIds = next;
  ownerPolicy = nextPolicy;
  notify();
}

export function noteChatSessionThreads(ids: ReadonlyArray<ThreadId> | undefined): void {
  const next = new Set<string>(ids ?? []);
  if (sameIds(next, sessionThreadIds)) return;
  sessionThreadIds = next;
  notify();
}

export function chatSessionListsThread(threadId: string): boolean {
  return sessionThreadIds.has(threadId);
}

export function chatThreadControls(threadId: string | null | undefined): ChatThreadControls {
  if (!active) return "full";
  if (threadId && ownerThreadIds.has(threadId)) return "owner";
  if (threadId && sessionThreadIds.size > 0 && !sessionThreadIds.has(threadId)) return "answer";
  return ownerPolicy ? "seat" : "unavailable";
}

export function chatSessionActive(): boolean {
  return active;
}

export function chatSessionOwnsThreads(): boolean {
  return active && ownerThreadIds.size > 0;
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
