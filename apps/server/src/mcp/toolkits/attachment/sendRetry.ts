import {
  type ChatAttachment,
  type OrchestrationV2ConversationMessage,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { unavailable } from "../../threadAccess.ts";
import { sendIdentity } from "../../threadSend.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const attachmentSendRetry = Effect.fn("mcp.attachmentSendRetry")(function* (input: {
  readonly threadId: ThreadId;
  readonly clientRequestId: string;
  readonly mode: string;
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}) {
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const enabled =
    Option.isSome(settings) &&
    (yield* settings.value.getSettings.pipe(Effect.mapError(unavailable))).liveThreadFeed;
  if (!enabled)
    return yield* invalid(
      "clientRequestId on attachment sends needs the Live thread feed setting.",
    );
  const { commandId, messageId } = yield* sendIdentity({
    crypto: yield* Crypto.Crypto,
    scope: yield* McpInvocationContext.McpInvocationContext,
    threadId: input.threadId,
    requestKey: input.clientRequestId,
    mode: input.mode,
    message: [input.message, ...input.attachments.map((attachment) => attachment.id)].join("\n"),
    operation: "thread-send-attachments",
  });
  const threads = yield* ThreadManagementService.ThreadManagementService;
  if (!(yield* threads.hasReceipt(commandId))) return { commandId, messageId };
  const sent = input.messages.find((message) => message.id === messageId);
  if (sent === undefined)
    return yield* invalid(
      "This clientRequestId already belongs to a different send to this thread. Retry with the same message, mode and attachments, or use a new clientRequestId.",
    );
  return { commandId, messageId, sent: sent.attachments };
});
