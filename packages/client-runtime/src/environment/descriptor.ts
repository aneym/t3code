import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import { chatSessionActive } from "../chatSession.ts";
import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;
const SHARED_DESCRIPTOR_MS = 5_000;

const handedOff = new Map<
  string,
  { readonly at: number; readonly descriptor: ExecutionEnvironmentDescriptor }
>();
const prefetched = new Map<string, Promise<unknown>>();

export function prefetchedEnvironmentDescriptor(httpBaseUrl: string, body: Promise<unknown>): void {
  prefetched.set(httpBaseUrl, body);
}

const takePrefetchedDescriptor = (httpBaseUrl: string) => {
  const body = prefetched.get(httpBaseUrl);
  prefetched.delete(httpBaseUrl);
  return body === undefined
    ? Effect.succeedNone
    : Effect.promise(() => body).pipe(
        Effect.timeoutOption(DEFAULT_REMOTE_REQUEST_TIMEOUT_MS),
        Effect.map(Option.flatMap(Schema.decodeUnknownOption(ExecutionEnvironmentDescriptor))),
      );
};

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

export const fetchSharedEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchSharedEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const early = yield* takePrefetchedDescriptor(input.httpBaseUrl);
  const descriptor = Option.isSome(early)
    ? early.value
    : yield* fetchRemoteEnvironmentDescriptor(input);
  handedOff.set(input.httpBaseUrl, { at: yield* Clock.currentTimeMillis, descriptor });
  return descriptor;
});

export const takeSharedEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.takeSharedEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string }) {
  const shared = handedOff.get(input.httpBaseUrl);
  handedOff.delete(input.httpBaseUrl);
  if (shared !== undefined && (yield* Clock.currentTimeMillis) - shared.at < SHARED_DESCRIPTOR_MS) {
    return shared.descriptor;
  }
  return yield* fetchRemoteEnvironmentDescriptor(input);
});
