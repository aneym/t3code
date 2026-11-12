import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Types from "effect/Types";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import { noteMcpCaller } from "../observability/RequestLog.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { withPeerRequestContext } from "./peerRequestContext.ts";

const mcpResourceMetadataUrl = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toURL(request).pipe(
    Option.map((url) => `${url.origin}/.well-known/oauth-protected-resource/mcp`),
  );

/** Launched agents cannot open OAuth browsers; OAuth would mint credentials outliving their session. */
const unauthorized = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presentedToken: boolean;
  readonly offerOAuth: boolean;
}) => {
  const metadataUrl = input.offerOAuth
    ? Option.getOrUndefined(mcpResourceMetadataUrl(input.request))
    : undefined;
  const challenge = [
    "Bearer",
    [
      ...(metadataUrl === undefined ? [] : [`resource_metadata="${metadataUrl}"`]),
      ...(input.presentedToken ? ['error="invalid_token"'] : []),
    ].join(", "),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      message: "A valid T3 Code MCP credential is required.",
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": challenge,
      },
    },
  );
};

export class McpClientAuthenticator extends Context.Service<
  McpClientAuthenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  }
>()("t3/mcp/McpAuthMiddleware/McpClientAuthenticator") {}

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const looksLikeProviderToken = (token: string) => token.length > 0 && !token.includes(".");

const invalidModeLimit = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mode_limit",
    message: "T3-Mode-Limit must be <runtimeMode>/<interactionMode>, e.g. auto/default.",
  },
  { status: 400, headers: { "cache-control": "no-store" } },
);

// The Linked environments beta is off here: links wait until it is on again.
const linkedEnvironmentsOff = HttpServerResponse.jsonUnsafe(
  {
    error: "linked_environments_off",
    message: "Linked environments is off on this machine. Turn it on in its Settings → Labs.",
  },
  { status: 403, headers: { "cache-control": "no-store" } },
);

const makeMcpAuthMiddleware = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const clients = yield* Effect.serviceOption(McpClientAuthenticator);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const runtimeModeCeiling = serverSettings.managedPolicy?.limits?.maxRuntimeMode;
  const linksEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
  return Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const token = parseBearerToken(request) ?? "";
    const invocation =
      (yield* registry.resolve(token)) ??
      (Option.isSome(clients) && token.length > 0
        ? yield* clients.value.authenticate(request)
        : undefined);
    if (!invocation) {
      yield* Effect.logWarning("rejected MCP request with an unusable credential", {
        reason:
          authorization === undefined
            ? "missing_authorization_header"
            : authorization.split(" ", 1)[0]?.toLowerCase() !== "bearer"
              ? "unsupported_scheme"
              : token.length === 0
                ? "missing_bearer_token"
                : "unknown_or_expired_token",
      });
      return unauthorized({
        request,
        presentedToken: token.length > 0,
        offerOAuth: Option.isSome(clients) && !looksLikeProviderToken(token),
      });
    }
    const asked = withPeerRequestContext(invocation, request);
    if (asked === undefined) return invalidModeLimit;
    const limited = McpInvocationContext.withRuntimeModeCeiling(asked, runtimeModeCeiling);
    yield* noteMcpCaller(limited);
    const linkedEnvironments = yield* linksEnabled;
    if (limited.client?.linked === true && !linkedEnvironments) return linkedEnvironmentsOff;
    return yield* httpEffect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...limited,
        linkedEnvironments,
      }),
      Effect.map(normalizeMcpHttpResponse),
    );
  }) satisfies McpAuthMiddleware;
}).pipe(Effect.withSpan("McpHttpServer.makeAuthMiddleware"));

export const layerMcpAuthMiddleware = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;
