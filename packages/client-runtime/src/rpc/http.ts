import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  type EnvironmentOperationForbiddenError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
  type EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as HttpObservability from "@t3tools/shared/httpObservability";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class RemoteEnvironmentAuthFetchError extends Schema.TaggedError<RemoteEnvironmentAuthFetchError>()(
  "RemoteEnvironmentAuthFetchError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

class RemoteEnvironmentAuthInvalidJsonError extends Schema.TaggedError<RemoteEnvironmentAuthInvalidJsonError>()(
  "RemoteEnvironmentAuthInvalidJsonError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Schema.TaggedError<RemoteEnvironmentAuthUndeclaredStatusError>()(
  "RemoteEnvironmentAuthUndeclaredStatusError",
  {
    status: Schema.Number,
    requestUrl: Schema.String,
    code: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Remote environment endpoint ${this.requestUrl} returned undeclared status ${this.status}.`;
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Schema.TaggedError<RemoteEnvironmentAuthTimeoutError>()(
  "RemoteEnvironmentAuthTimeoutError",
  {
    requestUrl: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Remote environment endpoint ${this.requestUrl} timed out after ${this.timeoutMs}ms.`;
  }
}

const isRemoteEnvironmentAuthTimeoutError = Schema.is(RemoteEnvironmentAuthTimeoutError);

export type RemoteEnvironmentRequestError =
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const layerRemoteHttpClient = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.merge(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    HttpObservability.layer,
  );

const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

const FORBIDDEN_BODY_LIMIT_BYTES = 4096;
const EMPTY_BODY = new Uint8Array(0);

class ForbiddenStatusSeen extends Context.Reference<{ readonly mark: () => void }>(
  "@t3tools/client-runtime/rpc/http/ForbiddenStatusSeen",
  { defaultValue: () => ({ mark: () => undefined }) },
) {}

const joinChunks = (chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array<ArrayBuffer> => {
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const readCappedStream = (
  stream: ReadableStream<Uint8Array>,
): Effect.Effect<Uint8Array<ArrayBuffer>> =>
  Effect.callback<Uint8Array<ArrayBuffer>>((resume) => {
    const reader = stream.getReader();
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    let settled = false;
    const cancel = () => void reader.cancel().catch(() => undefined);
    const finish = (body: Uint8Array<ArrayBuffer>) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(body));
    };
    const pump = (): void => {
      reader.read().then(
        (next) => {
          if (settled) return;
          if (next.done) return finish(joinChunks(chunks, size));
          size += next.value.byteLength;
          if (size > FORBIDDEN_BODY_LIMIT_BYTES) {
            cancel();
            return finish(EMPTY_BODY);
          }
          chunks.push(next.value);
          pump();
        },
        () => finish(EMPTY_BODY),
      );
    };
    pump();
    return Effect.sync(() => {
      settled = true;
      cancel();
    });
  });

const readCappedText = <E>(
  declaredLength: string | null | undefined,
  read: Effect.Effect<string, E>,
): Effect.Effect<Uint8Array<ArrayBuffer>> =>
  Number(declaredLength ?? 0) > FORBIDDEN_BODY_LIMIT_BYTES
    ? Effect.succeed(EMPTY_BODY)
    : read.pipe(
        Effect.map((text) => {
          const body = new TextEncoder().encode(text);
          return body.byteLength > FORBIDDEN_BODY_LIMIT_BYTES ? EMPTY_BODY : body;
        }),
        Effect.orElseSucceed(() => EMPTY_BODY),
      );

const readForbiddenBody = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Uint8Array<ArrayBuffer>> =>
  Option.match(HttpClientResponse.toWeb(response), {
    onNone: () => readCappedText(response.headers["content-length"], response.text),
    onSome: (source) =>
      typeof source.body?.getReader === "function"
        ? readCappedStream(source.body)
        : readCappedText(
            source.headers.get("content-length"),
            Effect.promise(() => source.text().catch(() => "")),
          ),
  });

const capForbiddenBody = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<HttpClientResponse.HttpClientResponse> =>
  response.status !== 403
    ? Effect.succeed(response)
    : ForbiddenStatusSeen.pipe(
        Effect.tap((seen) => Effect.sync(seen.mark)),
        Effect.andThen(readForbiddenBody(response)),
        Effect.map((body) => {
          const headers = new Headers(Object.entries(response.headers));
          headers.delete("content-encoding");
          headers.set("content-length", String(body.byteLength));
          return HttpClientResponse.fromWeb(
            response.request,
            new Response(body.byteLength === 0 ? null : body, { status: 403, headers }),
          );
        }),
      );

const withCappedForbiddenBodies = <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
  HttpClient.transformResponse(client, Effect.flatMap(capForbiddenBody));

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
    transformClient: withCappedForbiddenBodies,
  });

export const makeEnvironmentHttpApiGroupClient = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
>(
  httpBaseUrl: string,
  group: Group,
) =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    HttpApiClient.group(EnvironmentHttpApi, {
      httpClient: withCappedForbiddenBodies(httpClient),
      group,
      baseUrl: remoteApiBaseUrl(httpBaseUrl),
    }),
  );

export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) =>
  HttpApiClient.urlBuilder(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

const WEBSOCKET_TICKET_PATH = /\/api\/auth\/websocket-ticket(?:\/[^/]+)?$/;

export const isWebSocketTicketUrl = (requestUrl: string): boolean => {
  try {
    return WEBSOCKET_TICKET_PATH.test(new URL(requestUrl).pathname);
  } catch {
    return false;
  }
};

const parseRefusalCode = (text: string): string | undefined => {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string" &&
      body.code.length <= 64
      ? body.code
      : undefined;
  } catch {
    return undefined;
  }
};

const refusalCode = (
  requestUrl: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string | undefined> =>
  response.status === 403 && isWebSocketTicketUrl(requestUrl)
    ? response.text.pipe(
        Effect.map(parseRefusalCode),
        Effect.orElseSucceed(() => undefined),
      )
    : Effect.undefined;

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  if (isRemoteEnvironmentAuthTimeoutError(cause)) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return refusalCode(requestUrl, response).pipe(
        Effect.flatMap((code) =>
          Effect.fail(
            new RemoteEnvironmentAuthUndeclaredStatusError({
              requestUrl,
              status: response.status,
              ...(code === undefined ? {} : { code }),
            }),
          ),
        ),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      message: `Failed to fetch remote environment endpoint ${requestUrl} (${String(cause)}).`,
      cause,
    }),
  );
};

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  Effect.suspend(() => {
    let forbidden = false;
    return request.pipe(
      Effect.provideService(ForbiddenStatusSeen, {
        mark: () => {
          forbidden = true;
        },
      }),
      Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              forbidden
                ? new RemoteEnvironmentAuthUndeclaredStatusError({ requestUrl, status: 403 })
                : new RemoteEnvironmentAuthTimeoutError({ requestUrl, timeoutMs }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });
