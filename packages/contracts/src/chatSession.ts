import * as Schema from "effect/Schema";

import { AuthChatThreadsScope } from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

const CHAT_SESSION_SUBJECT_PREFIX = "chat-session:";
const CHAT_SESSION_MAX_THREADS = 500;
export const CHAT_SESSION_TTL_MS = 60 * 60_000;

export const ChatSessionThreadIds = Schema.Array(ThreadId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(CHAT_SESSION_MAX_THREADS),
);
export type ChatSessionThreadIds = typeof ChatSessionThreadIds.Type;

export const isChatSessionScopes = (scopes: ReadonlyArray<string> | undefined): boolean =>
  scopes?.includes(AuthChatThreadsScope) === true;

export const chatSessionSubject = (setId: string) => `${CHAT_SESSION_SUBJECT_PREFIX}${setId}`;

export const chatSessionSetId = (subject: string): string | null =>
  subject.startsWith(CHAT_SESSION_SUBJECT_PREFIX)
    ? subject.slice(CHAT_SESSION_SUBJECT_PREFIX.length) || null
    : null;

const O = ORCHESTRATION_V2_WS_METHODS;

export const CHAT_SESSION_METHODS: ReadonlySet<string> = new Set([
  O.dispatchCommand,
  O.getNativeChildWork,
  O.searchThread,
  O.searchThreadStream,
  O.getThreadFamily,
  O.getThreadTitles,
  O.getThreadLinkMetadata,
  O.getThreadProjection,
  O.getTurnItem,
  O.subscribeShell,
  O.subscribeThread,
  O.subscribeCommandOutput,
  O.subscribePromptSuggestion,
  WS_METHODS.serverGetConfig,
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.secretsAnswerRequest,
  WS_METHODS.assetsCreateUrl,
  WS_METHODS.assetsPersistChatAttachments,
  WS_METHODS.attachmentsCreateUploadUrl,
  WS_METHODS.attachmentsDelete,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
]);
