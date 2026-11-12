import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { HttpServerRequest } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { McpClientAuthenticator } from "../mcp/McpAuthMiddleware.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import type { McpClientSession } from "./McpClientSubjects.ts";
import { requestUrls } from "./mcpOAuthMetadata.ts";
import * as SessionStore from "./SessionStore.ts";

const DEFAULT_CACHE_TTL_MS = 5_000;
const MAX_CACHED_TOKENS = 1_024;

const cacheTtlMs = Config.Int("T3CODE_MCP_AUTH_CACHE_TTL_MS").pipe(
  Config.withDefault(DEFAULT_CACHE_TTL_MS),
);

interface CachedClient {
  readonly client: McpClientSession;
  readonly until: number;
}

const makeVerifiedClientCache = Effect.fn("McpClientAuthentication.makeCache")(function* (
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
) {
  const ttlMs = yield* cacheTtlMs.pipe(Effect.orElseSucceed(() => DEFAULT_CACHE_TTL_MS));
  if (ttlMs <= 0) return environmentAuth.authenticateMcpClient;
  const sessions = yield* SessionStore.SessionStore;
  const cached = new Map<string, CachedClient>();
  let removals = 0;
  yield* sessions.streamChanges.pipe(
    Stream.runForEach((change) =>
      Effect.sync(() => {
        if (change.type !== "clientRemoved") return;
        removals += 1;
        for (const [token, entry] of cached) {
          if (entry.client.sessionId === change.sessionId) cached.delete(token);
        }
      }),
    ),
    Effect.forkScoped,
  );
  const remember = (token: string, client: McpClientSession, now: number) => {
    if (cached.size >= MAX_CACHED_TOKENS) {
      for (const [key, entry] of cached) if (entry.until <= now) cached.delete(key);
      if (cached.size >= MAX_CACHED_TOKENS) cached.clear();
    }
    const expiresAt = client.expiresAt?.epochMilliseconds ?? Number.POSITIVE_INFINITY;
    cached.set(token, { client, until: Math.min(now + ttlMs, expiresAt) });
  };
  return (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const token = EnvironmentAuth.parseBearerToken(request);
      const now = yield* Clock.currentTimeMillis;
      const hit = token === null ? undefined : cached.get(token);
      if (hit !== undefined && hit.until > now) return hit.client;
      const removalsBefore = removals;
      const client = yield* environmentAuth.authenticateMcpClient(request);
      if (token !== null && removals === removalsBefore) remember(token, client, now);
      return client;
    });
});

export const layerMcpClientAuthenticator = Layer.effect(
  McpClientAuthenticator,
  Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const authenticateClient = yield* makeVerifiedClientCache(environmentAuth);
    return McpClientAuthenticator.of({
      authenticate: Effect.fn("McpClientAuthenticator.authenticate")(function (request) {
        return authenticateClient(request).pipe(
          Effect.flatMap((client) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((issuedAt): McpInvocationContext.McpInvocationScope => ({
                environmentId,
                requestNamespace: `client:${client.sessionId}`,
                thread: undefined,
                client: {
                  sessionId: client.sessionId,
                  label: client.label,
                  access: client.access,
                  linked: client.peerLink,
                  peer: client.peer,
                  ...(client.peerLink ? {} : { webOrigin: requestUrls(request).issuer }),
                  ownerCli: client.ownerCli,
                },
                capabilities: new Set<McpInvocationContext.McpCapability>([
                  "orchestration",
                  "worktree",
                  "pull-requests",
                ]),
                issuedAt,
              })),
            ),
          ),
          Effect.catch((error) =>
            (EnvironmentAuth.isServerAuthCredentialError(error)
              ? Effect.void
              : Effect.logWarning("MCP client authentication failed.", { cause: error })
            ).pipe(Effect.as(undefined)),
          ),
        );
      }),
    });
  }),
);
