import { AuthSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";

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

const readCredential = Effect.fn("cli.ownerSession.read")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(path).pipe(Effect.option);
  return Option.flatMap(raw, decodeCredential);
});

const writeCredential = Effect.fn("cli.ownerSession.write")(function* (
  directory: string,
  path: string,
  credential: CachedCredential,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
  const tempPath = `${path}.${yield* random.uuidV4()}.tmp`;
  yield* Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
        yield* file.writeAll(new TextEncoder().encode(encodeCredential(credential)));
      }),
    );
    yield* fileSystem.chmod(tempPath, 0o600);
    yield* fileSystem.rename(tempPath, path);
  }).pipe(Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)));
});

const isUsable = Effect.fn("cli.ownerSession.isUsable")(function* (credential: CachedCredential) {
  const now = yield* Clock.currentTimeMillis;
  return credential.expiresAtMs - Duration.toMillis(REFRESH_BEFORE_EXPIRY) > now;
});

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

export const openOwnerCliSession = Effect.fn("cli.ownerSession.open")(function* (
  secretsDir: string,
  endpoint: string,
  command: string,
  headers?: Readonly<Record<string, string>>,
) {
  const path = yield* Path.Path;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const cachePath = path.join(secretsDir, CACHE_FILE_NAME);
  const cached = yield* readCredential(cachePath);
  if (Option.isSome(cached) && (yield* isUsable(cached.value))) {
    const session = yield* openSession(endpoint, cached.value.token, command, headers).pipe(
      Effect.asSome,
      Effect.catchTags({
        AcpMcpBridgeError: (error) =>
          error.status === 401 ? Effect.succeedNone : Effect.fail(error),
      }),
    );
    if (Option.isSome(session)) return session.value;
  }
  const revoke = (sessionId: AuthSessionId) =>
    auth.revokeSession(sessionId).pipe(Effect.ignore({ log: true }));
  const keep = yield* Ref.make(false);
  const issued = yield* Effect.acquireRelease(
    auth.issueMcpClientSession({
      label: "t3 owner cli",
      access: "full-access",
      peerLink: false,
      ownerCli: true,
      client: { deviceType: "bot" },
    }),
    (minted) =>
      Ref.get(keep).pipe(Effect.flatMap((kept) => (kept ? Effect.void : revoke(minted.sessionId)))),
  );
  const credential: CachedCredential = {
    sessionId: issued.sessionId,
    token: issued.token,
    expiresAtMs: issued.expiresAt.epochMilliseconds,
  };
  yield* writeCredential(secretsDir, cachePath, credential).pipe(Effect.ignore);
  const published = yield* readCredential(cachePath);
  if (Option.exists(published, (current) => current.sessionId === credential.sessionId)) {
    yield* Ref.set(keep, true);
    if (Option.isSome(cached) && cached.value.sessionId !== credential.sessionId) {
      yield* revoke(cached.value.sessionId);
    }
  }
  return yield* openSession(endpoint, credential.token, command, headers);
});
