import {
  FORWARDED_SENDER_HEADER,
  ForwardedThreadSender,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { MODE_LIMIT_HEADER, type McpInvocationScope } from "./McpInvocationContext.ts";

const decodeModeLimit = Schema.decodeUnknownOption(
  Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
);
const decodeSender = Schema.decodeUnknownOption(Schema.fromJsonString(ForwardedThreadSender));

const invalidModeLimit = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mode_limit",
    message: "T3-Mode-Limit must be <runtimeMode>/<interactionMode>, e.g. auto/default.",
  },
  { status: 400, headers: { "cache-control": "no-store" } },
);

const invalidSender = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_thread_sender",
    message: "T3-Thread-Sender must name a thread and environment.",
  },
  { status: 400, headers: { "cache-control": "no-store" } },
);

export const withPeerRequestContext = (
  invocation: McpInvocationScope,
  request: HttpServerRequest.HttpServerRequest,
) => {
  if (invocation.client === undefined) return { invocation };
  let client = invocation.client;
  const mode = request.headers[MODE_LIMIT_HEADER];
  if (mode !== undefined) {
    const [runtimeMode, interactionMode, ...rest] = mode.trim().split("/");
    const limit = decodeModeLimit({ runtimeMode, interactionMode });
    if (rest.length !== 0 || Option.isNone(limit)) return { error: invalidModeLimit };
    client = { ...client, narrowedTo: limit.value };
  }
  const header = request.headers[FORWARDED_SENDER_HEADER];
  if (client.linked === true && header !== undefined) {
    const sender = decodeSender(header);
    if (Option.isNone(sender)) return { error: invalidSender };
    client = { ...client, sender: sender.value };
  }
  return { invocation: { ...invocation, client } };
};
