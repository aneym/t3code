import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import { chatSessionActive } from "../chatSession.ts";
import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "metadata");
  const request = executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.descriptor(),
  );
  if (!chatSessionActive()) return yield* request;
  const requestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
  return yield* request.pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      ...Option.getOrUndefined(requestInit),
      credentials: "omit",
    }),
  );
});
