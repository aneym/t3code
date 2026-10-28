import * as Schema from "effect/Schema";

const FORK_VERSION_RE = /^(\d+\.\d+\.\d+-nightly\.\d{8}\.(\d+))\.aneym\.([0-9A-Za-z-]+)$/;
const UPSTREAM_NIGHTLY_TAG_RE = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.(\d+)$/;

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

const UpstreamReleases = Schema.Array(
  Schema.Struct({ tag_name: Schema.String, draft: Schema.optional(Schema.Boolean) }),
);

export const decodeUpstreamReleases = Schema.decodeUnknownOption(UpstreamReleases);

export interface UpstreamNightlyStatus {
  readonly newestBuild: number;
  readonly buildsAhead: number;
  readonly buildsAheadIsLowerBound: boolean;
}

export function resolveUpstreamNightlyStatus(
  releases: ReadonlyArray<{ readonly tag_name: string; readonly draft?: boolean | undefined }>,
  currentBuild: number,
): UpstreamNightlyStatus | null {
  const builds = releases.flatMap((release) => {
    if (release.draft) return [];
    const build = UPSTREAM_NIGHTLY_TAG_RE.exec(release.tag_name)?.[1];
    return build === undefined ? [] : [Number(build)];
  });
  if (builds.length === 0) return null;
  const newer = builds.filter((build) => build > currentBuild);
  return {
    newestBuild: Math.max(...builds),
    buildsAhead: newer.length,
    buildsAheadIsLowerBound: newer.length === builds.length,
  };
}
