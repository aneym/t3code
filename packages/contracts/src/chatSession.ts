import * as Schema from "effect/Schema";

import { AuthChatThreadsScope } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";

const CHAT_SESSION_SUBJECT_PREFIX = "chat-session:";
const CHAT_SESSION_MAX_THREADS = 500;
export const CHAT_SESSION_TTL_MS = 60 * 60_000;
export const CHAT_SESSION_HISTORY_PAGE_BYTES = 196_608;

export const ChatSessionThreadIds = Schema.Array(ThreadId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(CHAT_SESSION_MAX_THREADS),
);
export type ChatSessionThreadIds = typeof ChatSessionThreadIds.Type;

export const ChatSessionOwnerThreadIds = Schema.Array(ThreadId).check(
  Schema.isMaxLength(CHAT_SESSION_MAX_THREADS),
);
export type ChatSessionOwnerThreadIds = typeof ChatSessionOwnerThreadIds.Type;

export const ChatSessionView = Schema.Struct({
  ownerThreadIds: ChatSessionOwnerThreadIds,
  threadIds: Schema.optionalKey(ChatSessionOwnerThreadIds),
});
export type ChatSessionView = typeof ChatSessionView.Type;

export const isChatSessionScopes = (scopes: ReadonlyArray<string> | undefined): boolean =>
  scopes?.includes(AuthChatThreadsScope) === true;

export const chatSessionSubject = (setId: string) => `${CHAT_SESSION_SUBJECT_PREFIX}${setId}`;

export const chatSessionSetId = (subject: string): string | null =>
  subject.startsWith(CHAT_SESSION_SUBJECT_PREFIX)
    ? subject.slice(CHAT_SESSION_SUBJECT_PREFIX.length) || null
    : null;
