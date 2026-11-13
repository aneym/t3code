import {
  EnvironmentId,
  FORWARDED_SENDER_HEADER,
  ForwardedThreadSender,
  OrchestrationV2LinkedSender,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import {
  MODE_LIMIT_HEADER,
  type McpInvocationScope,
  SENDER_THREAD_HEADER,
} from "./McpInvocationContext.ts";

const decodeModeLimit = Schema.decodeUnknownOption(
  Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
);
const parseModeLimit = (value: string) => {
  const [runtimeMode, interactionMode, ...rest] = value.trim().split("/");
  return rest.length === 0 ? decodeModeLimit({ runtimeMode, interactionMode }) : Option.none();
};

/** Applies a client's requested mode limit; undefined when the header is malformed. */
const withModeLimit = (
  invocation: McpInvocationScope,
  request: HttpServerRequest.HttpServerRequest,
): McpInvocationScope | undefined => {
  const header = request.headers[MODE_LIMIT_HEADER];
  if (header === undefined || invocation.client === undefined) return invocation;
  const limit = parseModeLimit(header);
  return Option.isNone(limit)
    ? undefined
    : { ...invocation, client: { ...invocation.client, narrowedTo: limit.value } };
};

const decodeSenderThread = Schema.decodeUnknownOption(OrchestrationV2LinkedSender);

/** Records the thread a linked environment calls for; a malformed header only loses the name. */
const withSenderThread = (
  invocation: McpInvocationScope,
  request: HttpServerRequest.HttpServerRequest,
): McpInvocationScope => {
  const header = request.headers[SENDER_THREAD_HEADER];
  if (header === undefined || invocation.client?.linked !== true) return invocation;
  const [environmentId, threadId, title, ...rest] = header.trim().split("/");
  if (environmentId === undefined || threadId === undefined || title === undefined)
    return invocation;
  if (rest.length > 0) return invocation;
  let decoded: Option.Option<OrchestrationV2LinkedSender>;
  try {
    decoded = decodeSenderThread({
      environmentId: decodeURIComponent(environmentId),
      threadId: decodeURIComponent(threadId),
      title: decodeURIComponent(title),
    });
  } catch {
    return invocation;
  }
  return Option.isNone(decoded)
    ? invocation
    : { ...invocation, client: { ...invocation.client, senderThread: decoded.value } };
};

const decodeSender = Schema.decodeUnknownOption(Schema.fromJsonString(ForwardedThreadSender));
const decodeOwnerCliSender = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ threadId: ThreadId, environmentId: Schema.optional(EnvironmentId) }),
  ),
);

export const withPeerRequestContext = (
  invocation: McpInvocationScope,
  request: HttpServerRequest.HttpServerRequest,
) => {
  const limited = withModeLimit(withSenderThread(invocation, request), request);
  if (limited === undefined || limited.client === undefined) return limited;
  let client = limited.client;
  const header = request.headers[FORWARDED_SENDER_HEADER];
  if (client.ownerCli === true && header !== undefined) {
    const sender = decodeOwnerCliSender(header);
    if (
      Option.isSome(sender) &&
      (sender.value.environmentId ?? invocation.environmentId) === invocation.environmentId
    ) {
      client = {
        ...client,
        sender: { threadId: sender.value.threadId, environmentId: invocation.environmentId },
      };
    }
  }
  if (client.linked === true && header !== undefined) {
    const sender = decodeSender(header);
    const peer = client.peer;
    if (
      Option.isSome(sender) &&
      peer !== undefined &&
      peer.environmentId !== invocation.environmentId &&
      sender.value.environmentId === peer.environmentId
    ) {
      client = {
        ...client,
        sender: {
          threadId: sender.value.threadId,
          environmentId: peer.environmentId,
          environmentLabel: peer.label,
        },
      };
    }
  }
  return { ...limited, client };
};
