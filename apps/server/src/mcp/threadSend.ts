import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import { type McpInvocationScope, threadLinkFor } from "./McpInvocationContext.ts";
import { requestPrincipal } from "./ownerCliSession.ts";
import {
  errorMessage,
  failure,
  isThreadManagementError,
  threadManagementFailure,
} from "./threadManagementFailure.ts";

const FINGERPRINT_CHARS = 32;

const sendIdentity = Effect.fn("OrchestratorMcpService.sendIdentity")(function* (input: {
  readonly crypto: Crypto.Crypto;
  readonly scope: McpInvocationScope;
  readonly threadId: OrchestratorMcpThreadSendInput["threadId"];
  readonly requestKey: string;
  readonly mode: string;
  readonly message: string;
}) {
  const digest = yield* input.crypto
    .digest("SHA-256", new TextEncoder().encode(`${input.mode}\n${input.message}`))
    .pipe(Effect.orDie);
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
  readonly crypto: Crypto.Crypto;
  readonly scope: McpInvocationScope;
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread"> | undefined;
  readonly target: Pick<OrchestrationV2ThreadProjection, "thread">;
  readonly request: OrchestratorMcpThreadSendInput;
}) {
  const { threadManagement, scope, parent, target, request } = input;
  const mode = request.mode ?? "queue";
  const requestKey =
    request.clientRequestId ?? (yield* input.crypto.randomUUIDv4().pipe(Effect.orDie));
  const { commandId, messageId } = yield* sendIdentity({
    crypto: input.crypto,
    scope,
    threadId: request.threadId,
    requestKey,
    mode,
    message: request.message,
  });

  const result = yield* threadManagement
    .sendToThread({
      projectId: target.thread.projectId,
      commandId,
      threadId: request.threadId,
      ...(parent === undefined ? {} : { senderThreadId: parent.thread.id }),
      messageId,
      text: request.message,
      attachments: [],
      mode,
      createdBy: "agent",
      creationSource: "mcp",
    })
    .pipe(
      Effect.mapError((error) =>
        isThreadManagementError(error)
          ? threadManagementFailure(error)
          : failure(
              "orchestration_error",
              `Unable to send to thread ${request.threadId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
            ),
      ),
    );
  return {
    threadId: request.threadId,
    link: threadLinkFor(scope, request.threadId),
    messageId,
    runId: result.run.id,
    ...(result.run.delegatedTaskId === undefined ? {} : { taskId: result.run.delegatedTaskId }),
    status: result.run.status,
    delivery: result.delivery,
    clientRequestId: requestKey,
    receipt: {
      commandId,
      sequence: result.dispatch.sequence,
      replayed: result.dispatch.replayed === true,
    },
  } satisfies OrchestratorMcpThreadSendResult;
});
