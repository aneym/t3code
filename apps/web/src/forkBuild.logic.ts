import * as Schema from "effect/Schema";

const UPSTREAM_NIGHTLY_TAG_RE = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.(\d+)$/;

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
