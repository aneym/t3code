import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

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
  O.getThreadHistoryPage,
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
