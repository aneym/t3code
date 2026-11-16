import * as Schema from "effect/Schema";

export const CLIENT_EXTRAS_MANIFEST_FILE = "client-extras.json";

export const CLIENT_EXTRAS_PATH_PATTERN =
  /^assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:otf|ttf|wasm)$/;

export function clientExtrasArchiveFileName(version: string): string {
  return `t3-${version}-client-extras.tar.gz`;
}

export const ClientExtrasFile = Schema.Struct({
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});

export const ClientExtrasManifest = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^[0-9A-Za-z.+-]+$/)),
  files: Schema.Record(
    Schema.String.check(Schema.isPattern(CLIENT_EXTRAS_PATH_PATTERN)),
    ClientExtrasFile,
  ),
});
export type ClientExtrasManifest = typeof ClientExtrasManifest.Type;
