import { AuthSessionId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const CachedCredential = Schema.Struct({
  sessionId: AuthSessionId,
  token: Schema.String,
  expiresAtMs: Schema.Number,
});
export type CachedCredential = typeof CachedCredential.Type;

const decodeCredential = Schema.decodeUnknownOption(Schema.fromJsonString(CachedCredential));
const encodeCredential = Schema.encodeSync(Schema.fromJsonString(CachedCredential));

const randomId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4()),
  Effect.orDie,
);

export const readCredential = Effect.fn("cli.credentialFile.read")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(path).pipe(Effect.option);
  return Option.flatMap(raw, decodeCredential);
});

export const writeCredential = Effect.fn("cli.credentialFile.write")(function* (
  directory: string,
  path: string,
  credential: CachedCredential,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
  const tempPath = `${path}.${yield* randomId}.tmp`;
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
