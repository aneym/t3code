import * as Schema from "effect/Schema";

const FORK_VERSION_RE = /^(\d+\.\d+\.\d+-nightly\.\d{8}\.(\d+))\.aneym\.([0-9A-Za-z-]+)$/;

export interface ForkVersion {
  readonly upstreamVersion: string;
  readonly upstreamBuild: number;
  readonly forkRevision: string;
}

export function parseForkVersion(version: string): ForkVersion | null {
  const match = FORK_VERSION_RE.exec(version.trim());
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return {
    upstreamVersion: match[1],
    upstreamBuild: Number(match[2]),
    forkRevision: match[3],
  };
}

const ForkBuildManifest = Schema.Struct({
  version: Schema.String,
  upstreamTag: Schema.String,
  builtAt: Schema.String,
  topics: Schema.Array(Schema.Struct({ branch: Schema.String, sha: Schema.String })),
});
export type ForkBuildManifest = typeof ForkBuildManifest.Type;

export const decodeForkBuildManifest = Schema.decodeUnknownOption(ForkBuildManifest);
