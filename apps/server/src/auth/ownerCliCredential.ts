import { AuthSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const OWNER_CLI_CREDENTIAL_PATH = "/api/owner-cli-credential";
const FILE_NAME = "owner-cli-session.json";
const REFRESH_BEFORE_EXPIRY = Duration.days(1);

const OwnerCliCredential = Schema.Struct({
  sessionId: AuthSessionId,
  token: Schema.String,
  expiresAtMs: Schema.Number,
});
export type OwnerCliCredential = typeof OwnerCliCredential.Type;

const decodeCredential = Schema.decodeUnknownOption(Schema.fromJsonString(OwnerCliCredential));
const encodeCredential = Schema.encodeSync(Schema.fromJsonString(OwnerCliCredential));

export const readOwnerCliCredential = Effect.fn("ownerCliCredential.read")(function* (
  secretsDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fileSystem
    .readFileString(path.join(secretsDir, FILE_NAME))
    .pipe(Effect.option);
  return Option.flatMap(raw, decodeCredential);
});

export const writeOwnerCliCredential = Effect.fn("ownerCliCredential.write")(function* (
  secretsDir: string,
  credential: OwnerCliCredential,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const target = path.join(secretsDir, FILE_NAME);
  yield* fileSystem.makeDirectory(secretsDir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
  const tempPath = `${target}.${yield* random.uuidV4()}.tmp`;
  yield* Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
        yield* file.writeAll(new TextEncoder().encode(encodeCredential(credential)));
      }),
    );
    yield* fileSystem.chmod(tempPath, 0o600);
    yield* fileSystem.rename(tempPath, target);
  }).pipe(Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)));
});

export const isFreshOwnerCliCredential = Effect.fn("ownerCliCredential.isFresh")(function* (
  credential: OwnerCliCredential,
) {
  const now = yield* Clock.currentTimeMillis;
  return credential.expiresAtMs - Duration.toMillis(REFRESH_BEFORE_EXPIRY) > now;
});
