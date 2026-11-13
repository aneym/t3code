import {
  clientMessageId,
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

import { mcpMessageSender } from "./messageSender.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { type McpInvocationScope, threadLinkFor } from "./McpInvocationContext.ts";
import { requestPrincipal } from "./ownerCliSession.ts";
import {
  dispatchBusyFailure,
  errorMessage,
  failure,
  isThreadManagementError,
  threadManagementFailure,
} from "./threadManagementFailure.ts";

const FINGERPRINT_CHARS = 32;

const sendIdentity = Effect.fn("OrchestratorMcpService.sendIdentity")(function* (input: {
  readonly digest: Digest.Digest["Service"];
  readonly scope: McpInvocationScope;
  readonly threadId: OrchestratorMcpThreadSendInput["threadId"];
  readonly requestKey: string;
  readonly mode: string;
  readonly message: string;
}) {
  const digest = yield* input.digest.digest(
    Digest.sha256,
    new TextEncoder().encode(`${input.mode}\n${input.message}`),
  );
  const key = [
    "mcp",
    encodeURIComponent(requestPrincipal(input.scope)),
    "thread-send",
    encodeURIComponent(input.threadId),
    encodeURIComponent(input.requestKey),
  ].join(":");
  return {
    commandId: CommandId.make(`command:${key}`),
    messageId: MessageId.make(`message:${key}:${Hex.encode(digest).slice(0, FINGERPRINT_CHARS)}`),
  };
});

export const sendToThread = Effect.fn("OrchestratorMcpService.sendToThread")(function* (input: {
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly digest: Digest.Digest["Service"];
  readonly scope: McpInvocationScope;
  readonly target: Pick<OrchestrationV2ThreadProjection, "thread">;
  readonly request: OrchestratorMcpThreadSendInput;
}) {
  const { threadManagement, scope, target, request } = input;
  const mode = request.mode ?? "queue";
  const requestKey = request.clientRequestId ?? (yield* input.random.uuidV4());
  const { commandId, messageId } =
    request.composerIds === undefined
      ? yield* sendIdentity({
          digest: input.digest,
          scope,
          threadId: request.threadId,
          requestKey,
          mode,
          message: request.message,
        })
      : {
          commandId: request.composerIds.commandId,
          messageId: clientMessageId(request.composerIds.messageId),
        };

  const ownerCliSender = scope.client?.ownerCli === true ? scope.client.sender : undefined;
  if (ownerCliSender !== undefined) {
    const shell = yield* threadManagement
      .getThreadShell(ownerCliSender.threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null)
      return yield* failure(
        "invalid_request",
        `Sender thread ${ownerCliSender.threadId} was not found in this environment.`,
      );
  }
  const send = {
    projectId: target.thread.projectId,
    commandId,
    threadId: request.threadId,
    ...mcpMessageSender(scope),
    ...(scope.thread === undefined && scope.client?.senderThread !== undefined
      ? { linkedSender: scope.client.senderThread }
      : {}),
    messageId,
    text: request.message,
    attachments: [],
    createdBy: "agent",
    creationSource: "mcp",
  } as const;
  const result = yield* (
    mode === "note"
      ? threadManagement.noteToThread(send)
      : threadManagement.sendToThread({
          ...send,
          mode,
          ...(request.freshContext ? { freshContext: true } : {}),
        })
  ).pipe(
    Effect.mapError((error) =>
      isThreadManagementError(error) || dispatchBusyFailure(error) !== undefined
        ? threadManagementFailure(error)
        : failure(
            "orchestration_error",
            `Unable to send to thread ${request.threadId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
          ),
    ),
  );
  const receipt = {
    commandId,
    sequence: result.dispatch.sequence,
    replayed: result.dispatch.replayed === true,
  };
  if (!("run" in result))
    return {
      threadId: request.threadId,
      link: threadLinkFor(scope, request.threadId, target.thread.title),
      messageId,
      delivery: result.delivery,
      clientRequestId: requestKey,
      receipt,
    } satisfies OrchestratorMcpThreadSendResult;
  return {
    threadId: request.threadId,
    link: threadLinkFor(scope, request.threadId, target.thread.title),
    messageId,
    runId: result.run.id,
    ...(result.run.delegatedTaskId === undefined ? {} : { taskId: result.run.delegatedTaskId }),
    status: result.run.status,
    delivery: result.delivery,
    ...(result.holdReason === undefined ? {} : { holdReason: result.holdReason }),
    ...(result.next === undefined ? {} : { next: result.next }),
    clientRequestId: requestKey,
    receipt,
  } satisfies OrchestratorMcpThreadSendResult;
});
