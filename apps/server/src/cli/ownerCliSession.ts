import { AuthSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import * as CliAuthRuntime from "./cliAuthRuntime.ts";

const CACHE_FILE_NAME = "owner-cli-session.json";
const REFRESH_BEFORE_EXPIRY = Duration.minutes(5);

const CachedCredential = Schema.Struct({
  sessionId: AuthSessionId,
  token: Schema.String,
  expiresAtMs: Schema.Number,
});
type CachedCredential = typeof CachedCredential.Type;

const decodeCredential = Schema.decodeUnknownOption(Schema.fromJsonString(CachedCredential));
const encodeCredential = Schema.encodeSync(Schema.fromJsonString(CachedCredential));

const withAuth = <A, E>(
  config: ServerConfig.ServerConfig["Service"],
  use: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
) =>
  EnvironmentAuth.EnvironmentAuth.pipe(
    Effect.flatMap(use),
    Effect.provide(
      CliAuthRuntime.layer.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );

const readCredential = Effect.fn("cli.owner.session.readCache")(function* (cachePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(cachePath).pipe(Effect.option);
  return Option.flatMap(raw, decodeCredential);
});

const isUsable = Effect.fn("cli.owner.session.isUsable")(function* (credential: CachedCredential) {
  const now = yield* Clock.currentTimeMillis;
  return credential.expiresAtMs - Duration.toMillis(REFRESH_BEFORE_EXPIRY) > now;
});

const randomId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4()),
  Effect.orDie,
);

const writeCredential = Effect.fn("cli.owner.session.writeCache")(function* (
  cachePath: string,
  credential: CachedCredential,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const tempPath = `${cachePath}.${yield* randomId}.tmp`;
  yield* Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
        yield* file.writeAll(new TextEncoder().encode(encodeCredential(credential)));
      }),
    );
    yield* fileSystem.chmod(tempPath, 0o600);
    yield* fileSystem.rename(tempPath, cachePath);
  }).pipe(
    Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
    Effect.ignore,
  );
});

const mint = Effect.fn("cli.owner.session.mint")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const issued = yield* withAuth(config, (auth) =>
    auth.issueMcpClientSession({
      label: "t3 owner cli",
      peerLink: false,
      ownerCli: true,
      access: "full-access",
      client: { deviceType: "bot" },
    }),
  );
  return {
    sessionId: issued.sessionId,
    token: issued.token,
    expiresAtMs: issued.expiresAt.epochMilliseconds,
  } satisfies CachedCredential;
});

const revoke = (config: ServerConfig.ServerConfig["Service"], sessionId: AuthSessionId) =>
  withAuth(config, (auth) => auth.revokeSession(sessionId)).pipe(Effect.ignore({ log: true }));

const openSession = (endpoint: string, token: string, command: string) =>
  mcpToolSession({
    endpoint,
    clientName: `t3-${command}-cli`,
    authorization: `Bearer ${token}`,
  });

export const openOwnerCliSession = Effect.fn("cli.owner.session.open")(function* (
  config: ServerConfig.ServerConfig["Service"],
  endpoint: string,
  command: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cachePath = path.join(config.secretsDir, CACHE_FILE_NAME);
  const cached = yield* readCredential(cachePath);
  if (Option.isSome(cached) && (yield* isUsable(cached.value))) {
    const session = yield* openSession(endpoint, cached.value.token, command).pipe(
      Effect.asSome,
      Effect.catchTags({
        AcpMcpBridgeError: (error) =>
          error.status === 401 ? Effect.succeedNone : Effect.fail(error),
      }),
    );
    if (Option.isSome(session)) return session.value;
  }
  const replaced = Option.map(cached, (credential) => credential.sessionId);
  const keep = yield* Ref.make(false);
  const credential = yield* Effect.acquireRelease(mint(config), (minted) =>
    Ref.get(keep).pipe(
      Effect.flatMap((kept) => (kept ? Effect.void : revoke(config, minted.sessionId))),
    ),
  );
  yield* fileSystem
    .makeDirectory(config.secretsDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.ignore);
  yield* writeCredential(cachePath, credential);
  const published = yield* readCredential(cachePath);
  if (Option.exists(published, (current) => current.sessionId === credential.sessionId)) {
    yield* Ref.set(keep, true);
  }
  if (Option.isSome(replaced) && replaced.value !== credential.sessionId) {
    yield* revoke(config, replaced.value);
  }
  return yield* openSession(endpoint, credential.token, command);
});
