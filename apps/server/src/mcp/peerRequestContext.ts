import {
  FORWARDED_SENDER_HEADER,
  ForwardedThreadSender,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import { MODE_LIMIT_HEADER, type McpInvocationScope } from "./McpInvocationContext.ts";

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

const decodeSender = Schema.decodeUnknownOption(Schema.fromJsonString(ForwardedThreadSender));

export const withPeerRequestContext = (
  invocation: McpInvocationScope,
  request: HttpServerRequest.HttpServerRequest,
) => {
  const limited = withModeLimit(invocation, request);
  if (limited === undefined || limited.client === undefined) return limited;
  let client = limited.client;
  const header = request.headers[FORWARDED_SENDER_HEADER];
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
