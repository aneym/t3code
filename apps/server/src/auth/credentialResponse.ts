import type { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

export const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

export const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

export const appendDpopChallengeOnUnauthorized =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (error: EnvironmentAuthInvalidError) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      /^DPoP /i.test(request.headers.authorization ?? "");
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });
