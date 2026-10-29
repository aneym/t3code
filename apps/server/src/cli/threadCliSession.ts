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
const REFRESH_BEFORE_EXPIRY = Duration.days(1);

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

const readUsableCredential = Effect.fn("cli.thread.session.readCache")(function* (
  cachePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(cachePath).pipe(Effect.option);
  const now = yield* Clock.currentTimeMillis;
  return Option.flatMap(raw, decodeCredential).pipe(
    Option.filter(
      (credential) => credential.expiresAtMs - Duration.toMillis(REFRESH_BEFORE_EXPIRY) > now,
    ),
  );
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

const forgetCredential = Effect.fn("cli.thread.session.forgetCache")(function* (
  cachePath: string,
  sessionId: AuthSessionId,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const current = yield* fileSystem.readFileString(cachePath).pipe(Effect.option);
  if (Option.exists(Option.flatMap(current, decodeCredential), (c) => c.sessionId === sessionId)) {
    yield* fileSystem.remove(cachePath, { force: true }).pipe(Effect.ignore);
  }
});

const openSession = (endpoint: string, token: string) => {
  let rejected = false;
  return mcpToolSession({
    endpoint,
    clientName: "t3-thread-cli",
    authorization: `Bearer ${token}`,
    fetchImplementation: (url, init) =>
      // @effect-diagnostics-next-line globalFetch:off -- mcpToolSession takes a fetch-shaped transport.
      fetch(url, init).then((response) => {
        if (response.status === 401) rejected = true;
        return response;
      }),
  }).pipe(
    Effect.asSome,
    Effect.catchTags({
      AcpMcpBridgeError: (error) => (rejected ? Effect.succeedNone : Effect.fail(error)),
    }),
  );
};

const issueAndStore = Effect.fn("cli.thread.session.issue")(function* (
  config: ServerConfig.ServerConfig["Service"],
  cachePath: string,
) {
  const issued = yield* withAuth(config, (auth) =>
    auth.issueMcpClientSession({
      label: "t3 thread cli",
      // The CLI runs as the machine's owner. New threads still start at
      // the project's default mode, never at this ceiling by default.
      access: "full-access",
      client: { deviceType: "bot" },
    }),
  );
  const racedIn = yield* readUsableCredential(cachePath);
  if (Option.isSome(racedIn) && racedIn.value.sessionId !== issued.sessionId) {
    yield* withAuth(config, (auth) => auth.revokeSession(issued.sessionId)).pipe(
      Effect.ignore({ log: true }),
    );
    return racedIn.value;
  }
  const credential = {
    sessionId: issued.sessionId,
    token: issued.token,
    expiresAtMs: issued.expiresAt.epochMilliseconds,
  };
  yield* writeCredential(cachePath, credential);
  return credential;
});

export const openThreadCliSession = Effect.fn("cli.thread.session.open")(function* (
  config: ServerConfig.ServerConfig["Service"],
  endpoint: string,
) {
  const path = yield* Path.Path;
  const cachePath = path.join(config.secretsDir, CACHE_FILE_NAME);
  const cached = yield* readUsableCredential(cachePath);
  if (Option.isSome(cached)) {
    const session = yield* openSession(endpoint, cached.value.token);
    if (Option.isSome(session)) return session.value;
    yield* forgetCredential(cachePath, cached.value.sessionId);
  }
  const credential = yield* issueAndStore(config, cachePath);
  return yield* mcpToolSession({
    endpoint,
    clientName: "t3-thread-cli",
    authorization: `Bearer ${credential.token}`,
  });
});
