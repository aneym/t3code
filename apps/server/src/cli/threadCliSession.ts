import { AuthSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import * as CliAuthRuntime from "./cliAuthRuntime.ts";

const CACHE_FILE_NAME = "thread-cli-session.json";
const LOCK_FILE_NAME = "thread-cli-session.lock";
const REFRESH_BEFORE_EXPIRY = Duration.minutes(5);
const LOCK_WAIT = Duration.seconds(15);
const LOCK_POLL = Duration.millis(100);
const LOCK_STALE_AFTER = Duration.seconds(60);

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

const readCredential = Effect.fn("cli.thread.session.readCache")(function* (cachePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(cachePath).pipe(Effect.option);
  return Option.flatMap(raw, decodeCredential);
});

const isUsable = Effect.fn("cli.thread.session.isUsable")(function* (credential: CachedCredential) {
  const now = yield* Clock.currentTimeMillis;
  return credential.expiresAtMs - Duration.toMillis(REFRESH_BEFORE_EXPIRY) > now;
});

const writeCredential = Effect.fn("cli.thread.session.writeCache")(function* (
  cachePath: string,
  credential: CachedCredential,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const tempPath = `${cachePath}.${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.tmp`;
  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.dirname(cachePath), { recursive: true, mode: 0o700 });
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
    Effect.ignore({ log: true }),
  );
});

type LockAttempt = "taken" | "busy" | "unavailable";

const tryTakeLock = Effect.fn("cli.thread.session.tryTakeLock")(function* (lockPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const attempt: LockAttempt = yield* fileSystem
    .writeFileString(lockPath, "", { flag: "wx", mode: 0o600 })
    .pipe(
      Effect.as<LockAttempt>("taken"),
      Effect.catchReason("PlatformError", "AlreadyExists", () =>
        Effect.succeed<LockAttempt>("busy"),
      ),
      Effect.orElseSucceed((): LockAttempt => "unavailable"),
    );
  if (attempt !== "busy") return attempt;
  const now = yield* Clock.currentTimeMillis;
  const info = yield* fileSystem.stat(lockPath).pipe(Effect.option);
  const stale = Option.exists(
    Option.flatMap(info, (stat) => stat.mtime),
    (mtime) => now - mtime.getTime() > Duration.toMillis(LOCK_STALE_AFTER),
  );
  if (stale) yield* fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore);
  return attempt;
});

const acquireLock = Effect.fn("cli.thread.session.acquireLock")(function* (lockPath: string) {
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(LOCK_WAIT);
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const attempt = yield* tryTakeLock(lockPath);
    if (attempt !== "busy") return attempt === "taken";
    yield* Effect.sleep(LOCK_POLL);
  }
  return false;
});

const mint = Effect.fn("cli.thread.session.mint")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const issued = yield* withAuth(config, (auth) =>
    auth.issueMcpClientSession({
      label: "t3 thread cli",
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

const refreshCached = Effect.fn("cli.thread.session.refresh")(function* (
  config: ServerConfig.ServerConfig["Service"],
  cachePath: string,
  replaced: Option.Option<AuthSessionId>,
) {
  const current = yield* readCredential(cachePath);
  if (
    Option.isSome(current) &&
    !Option.contains(replaced, current.value.sessionId) &&
    (yield* isUsable(current.value))
  ) {
    return current.value;
  }
  const credential = yield* mint(config);
  yield* writeCredential(cachePath, credential);
  if (Option.isSome(replaced)) yield* revoke(config, replaced.value);
  return credential;
});

const openSession = (endpoint: string, token: string) =>
  mcpToolSession({
    endpoint,
    clientName: "t3-thread-cli",
    authorization: `Bearer ${token}`,
  });

export const openThreadCliSession = Effect.fn("cli.thread.session.open")(function* (
  config: ServerConfig.ServerConfig["Service"],
  endpoint: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cachePath = path.join(config.secretsDir, CACHE_FILE_NAME);
  const lockPath = path.join(config.secretsDir, LOCK_FILE_NAME);
  const cached = yield* readCredential(cachePath);
  if (Option.isSome(cached) && (yield* isUsable(cached.value))) {
    const session = yield* openSession(endpoint, cached.value.token).pipe(
      Effect.asSome,
      Effect.catchTags({
        AcpMcpBridgeError: (error) =>
          error.status === 401 ? Effect.succeedNone : Effect.fail(error),
      }),
    );
    if (Option.isSome(session)) return session.value;
  }
  const replaced = Option.map(cached, (credential) => credential.sessionId);
  yield* fileSystem
    .makeDirectory(config.secretsDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.ignore);
  const refreshed = yield* Effect.scoped(
    Effect.gen(function* () {
      const held = yield* Effect.acquireRelease(acquireLock(lockPath), (taken) =>
        taken ? fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore) : Effect.void,
      );
      return held ? Option.some(yield* refreshCached(config, cachePath, replaced)) : Option.none();
    }),
  );
  const credential = Option.isSome(refreshed)
    ? refreshed.value
    : yield* Effect.acquireRelease(mint(config), (uncached) => revoke(config, uncached.sessionId));
  return yield* openSession(endpoint, credential.token);
});
