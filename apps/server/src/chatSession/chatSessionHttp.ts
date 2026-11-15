import { chatSessionSetId, isChatSessionScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ASSET_ROUTE_PREFIX } from "../assets/AssetAccess.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../assets/AttachmentUpload.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { base64UrlDecodeUtf8 } from "../auth/utils.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ChatSessionAccess from "./ChatSessionAccess.ts";
import * as ChatSessionGrants from "./ChatSessionGrants.ts";
import * as ChatThreadSets from "./ChatThreadSets.ts";

const AUTHORIZATION_SCHEMES = ["Bearer ", "DPoP "];
const READ_METHODS = new Set(["GET", "HEAD"]);
const STATIC_PREFIXES = ["/embed/", "/assets/"];

const claimsChatScope = (token: string): boolean => {
  try {
    const claims: unknown = JSON.parse(base64UrlDecodeUtf8(token.split(".", 1)[0] ?? ""));
    return (
      typeof claims === "object" &&
      claims !== null &&
      "scopes" in claims &&
      Array.isArray(claims.scopes) &&
      isChatSessionScopes(claims.scopes)
    );
  } catch {
    return false;
  }
};

const isStaticPath = (path: string) =>
  STATIC_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
  /^\/[^/.][^/]*\.[A-Za-z0-9]+$/.test(path);

const forbidden = () =>
  HttpServerResponse.jsonUnsafe(
    { code: "chat_session_forbidden", message: "A chat session cannot make this request." },
    { status: 403 },
  );

const credentials = (
  request: HttpServerRequest.HttpServerRequest,
  cookieNames: ReadonlyArray<string>,
) => {
  const authorization = request.headers.authorization ?? "";
  const scheme = AUTHORIZATION_SCHEMES.find((prefix) => authorization.startsWith(prefix));
  return [
    ...cookieNames.map((name) => request.cookies[name]),
    scheme === undefined ? undefined : authorization.slice(scheme.length).trim(),
  ].filter((token): token is string => token !== undefined && token.length > 0);
};

const layerGate = HttpRouter.middleware(
  Effect.gen(function* () {
    const sessions = yield* SessionStore;
    const grants = yield* ChatSessionGrants.ChatSessionGrants;
    const cookieNames = [sessions.cookieName, sessions.legacyCookieName].filter(
      (name): name is string => name !== undefined,
    );
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const chatTokens = credentials(request, cookieNames).filter(claimsChatScope);
        const unchat = Effect.gen(function* () {
          const path = Option.map(requestUrl(request), (url) => url.pathname);
          return Option.isSome(path) && (yield* grants.isBound(path.value))
            ? forbidden()
            : yield* httpEffect;
        });
        if (chatTokens.length === 0) return yield* unchat;
        const verified = yield* Effect.forEach(chatTokens, (token) =>
          sessions.verify(token).pipe(Effect.option),
        );
        const session = verified
          .flatMap((candidate) =>
            Option.isSome(candidate) && isChatSessionScopes(candidate.value.scopes)
              ? [candidate.value]
              : [],
          )
          .at(0);
        if (session === undefined) return yield* unchat;
        const setId = chatSessionSetId(session.subject);
        const url = requestUrl(request);
        if (setId === null || Option.isNone(url)) return forbidden();
        const path = url.value.pathname;
        const allowed =
          (READ_METHODS.has(request.method) &&
            (path === "/api/auth/session" || path === "/ws" || isStaticPath(path))) ||
          (READ_METHODS.has(request.method) &&
            path.startsWith(`${ASSET_ROUTE_PREFIX}/`) &&
            (yield* grants.allowsPath(setId, path))) ||
          (request.method === "POST" &&
            path.startsWith(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`) &&
            (yield* grants.allowsPath(setId, path)));
        return allowed ? yield* httpEffect : forbidden();
      });
  }),
  { global: true },
);

export const layer = layerGate.pipe(
  Layer.provideMerge(ChatSessionAccess.layer.pipe(Layer.provide(ProjectionStore.layer))),
  Layer.provideMerge(Layer.mergeAll(ChatSessionGrants.layer, ChatThreadSets.layer)),
);
