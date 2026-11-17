import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

import {
  isFreshOwnerCliCredential,
  OWNER_CLI_CREDENTIAL_PATH,
  readOwnerCliCredential,
} from "../auth/ownerCliCredential.ts";
import { AcpMcpBridgeError, mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";

class OwnerCliCredentialUnavailableError extends Schema.TaggedError<OwnerCliCredentialUnavailableError>()(
  "OwnerCliCredentialUnavailableError",
  { secretsDir: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `The running T3 Code server did not publish a usable owner CLI credential in ${this.secretsDir} (${this.detail}). Restart T3 Code, or update the t3 CLI to match the server.`;
  }
}

const openSession = (
  endpoint: string,
  token: string,
  command: string,
  headers: Readonly<Record<string, string>> | undefined,
) =>
  mcpToolSession({
    endpoint,
    authorization: `Bearer ${token}`,
    clientName: `t3-${command}-cli`,
    ...(headers === undefined ? {} : { headers }),
  });

const requestPublish = Effect.fn("cli.ownerSession.requestPublish")(function* (
  origin: string,
  secretsDir: string,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.post(new URL(OWNER_CLI_CREDENTIAL_PATH, origin)).pipe(
    Effect.mapError(
      (cause) =>
        new AcpMcpBridgeError({
          message: "Could not ask the server for the owner CLI credential.",
          cause,
        }),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new OwnerCliCredentialUnavailableError({
      secretsDir,
      detail: `HTTP ${response.status}`,
    });
  }
}, Effect.provide(FetchHttpClient.layer));

export const openOwnerCliSession = Effect.fn("cli.ownerSession.open")(function* (
  secretsDir: string,
  origin: string,
  command: string,
  headers?: Readonly<Record<string, string>>,
) {
  const endpoint = new URL("/mcp", origin).href;
  const cached = yield* readOwnerCliCredential(secretsDir);
  if (Option.isSome(cached) && (yield* isFreshOwnerCliCredential(cached.value))) {
    const session = yield* openSession(endpoint, cached.value.token, command, headers).pipe(
      Effect.asSome,
      Effect.catchTags({
        AcpMcpBridgeError: (error) =>
          error.status === 401 ? Effect.succeedNone : Effect.fail(error),
      }),
    );
    if (Option.isSome(session)) return session.value;
  }
  yield* requestPublish(origin, secretsDir);
  const published = yield* readOwnerCliCredential(secretsDir);
  if (Option.isNone(published) || !(yield* isFreshOwnerCliCredential(published.value))) {
    return yield* new OwnerCliCredentialUnavailableError({
      secretsDir,
      detail: "missing or expired",
    });
  }
  return yield* openSession(endpoint, published.value.token, command, headers).pipe(
    Effect.catchTags({
      AcpMcpBridgeError: (error) =>
        error.status === 401
          ? Effect.fail(new OwnerCliCredentialUnavailableError({ secretsDir, detail: "rejected" }))
          : Effect.fail(error),
    }),
  );
});
