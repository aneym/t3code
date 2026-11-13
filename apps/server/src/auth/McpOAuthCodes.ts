import { AuthMcpClientAccess } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const PendingCode = Schema.Struct({
  clientId: Schema.String,
  clientName: Schema.String,
  peerLink: Schema.Boolean,
  redirectUri: Schema.String,
  codeChallenge: Schema.String,
  resource: Schema.String,
  access: AuthMcpClientAccess,
  expiresAtMs: Schema.Number,
});

class McpOAuthCodeStoreError extends Schema.TaggedError<McpOAuthCodeStoreError>()(
  "McpOAuthCodeStoreError",
  { cause: Schema.Defect() },
) {}

export class McpOAuthCodes extends Context.Service<
  McpOAuthCodes,
  {
    readonly put: (
      hash: string,
      code: typeof PendingCode.Type,
      now: number,
    ) => Effect.Effect<void, McpOAuthCodeStoreError>;
    readonly take: (
      hash: string,
    ) => Effect.Effect<typeof PendingCode.Type | undefined, McpOAuthCodeStoreError>;
  }
>()("t3/auth/McpOAuthCodes") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const gate = yield* Semaphore.make(1);
  const name = "mcp-oauth-pending-codes";
  const codec = Schema.fromJsonString(Schema.Record(Schema.String, PendingCode));
  const read = secrets
    .get(name)
    .pipe(
      Effect.flatMap((stored) =>
        Option.isNone(stored)
          ? Effect.succeed({} as Record<string, typeof PendingCode.Type>)
          : Schema.decodeEffect(codec)(new TextDecoder().decode(stored.value)),
      ),
    );
  const write = (codes: Record<string, typeof PendingCode.Type>) =>
    Schema.encodeEffect(codec)(codes).pipe(
      Effect.flatMap((encoded) => secrets.set(name, new TextEncoder().encode(encoded))),
    );
  return McpOAuthCodes.of({
    put: Effect.fn("McpOAuthCodes.put")(
      function* (hash, code, now) {
        const current = yield* read;
        const next = Object.fromEntries(
          Object.entries(current).filter(([, pending]) => pending.expiresAtMs > now),
        );
        next[hash] = code;
        yield* write(next);
      },
      gate.withPermits(1),
      Effect.mapError((cause) => new McpOAuthCodeStoreError({ cause })),
    ),
    take: Effect.fn("McpOAuthCodes.take")(
      function* (hash) {
        const current = yield* read;
        const code = current[hash];
        if (code === undefined) return undefined;
        const next = { ...current };
        delete next[hash];
        yield* write(next);
        return code;
      },
      gate.withPermits(1),
      Effect.mapError((cause) => new McpOAuthCodeStoreError({ cause })),
    ),
  });
});

export const layer = Layer.effect(McpOAuthCodes, make);
