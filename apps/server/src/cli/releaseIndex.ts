import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CLI_RELEASE_BASE_URL_ENV,
  cliReleaseIndexPageUrl,
  isCliForkVersion,
  newestCliReleaseVersion,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { compareExactServiceVersions, isExactServiceVersion } from "../cloud/serviceProtocol.ts";

export class ReleaseIndexError extends Schema.TaggedError<ReleaseIndexError>()(
  "ReleaseIndexError",
  { reason: Schema.String },
) {}

const GitHubReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
  }),
);
const decodeGitHubReleaseIndex = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GitHubReleaseIndex),
);

const ReleaseFeed = Schema.Struct({
  releases: Schema.Array(
    Schema.Struct({ version: Schema.String, cli: Schema.Array(Schema.String) }),
  ),
});

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);
const RELEASE_INDEX_MAX_PAGES = 10;

const newestFeedVersion = Effect.fn("cli.update.resolve_newest_feed")(function* (
  baseUrl: string,
  platformKey: string,
) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const url = `${baseUrl.replace(/\/+$/, "")}/releases.json`;
  const feed = yield* http.get(url).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ReleaseFeed)),
    Effect.mapError(() => new ReleaseIndexError({ reason: `Could not read ${url}.` })),
    Effect.timeoutOrElse({
      duration: RELEASE_INDEX_TIMEOUT,
      orElse: () => Effect.fail(new ReleaseIndexError({ reason: `Timed out reading ${url}.` })),
    }),
  );
  const newest = feed.releases
    .filter(
      ({ version, cli }) =>
        isExactServiceVersion(version) && isCliForkVersion(version) && cli.includes(platformKey),
    )
    .map((release) => release.version)
    .toSorted((a, b) => compareExactServiceVersions(b, a))[0];
  if (newest === undefined) {
    return yield* new ReleaseIndexError({ reason: `${url} lists no release for ${platformKey}.` });
  }
  return newest;
});

export const resolveNewestVersion = Effect.fn("cli.update.resolve_newest")(function* (
  channel: CliReleaseChannel,
  currentVersion?: string,
  platformKey?: string,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const feed = environment[CLI_RELEASE_BASE_URL_ENV]?.trim();
  if (feed && platformKey && channel === "nightly" && isCliForkVersion(currentVersion ?? "")) {
    return yield* newestFeedVersion(feed, platformKey);
  }
  const githubToken = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim() || undefined;
  for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
    const request = HttpClientRequest.get(cliReleaseIndexPageUrl(page, currentVersion)).pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
    );
    const authenticatedRequest =
      githubToken === undefined
        ? request
        : HttpClientRequest.setHeader(request, "Authorization", `Bearer ${githubToken}`);
    const body = yield* httpClient.execute(authenticatedRequest).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.mapError(() => new ReleaseIndexError({ reason: "Could not list t3 releases." })),
      Effect.timeoutOrElse({
        duration: RELEASE_INDEX_TIMEOUT,
        orElse: () =>
          Effect.fail(new ReleaseIndexError({ reason: "Timed out listing t3 releases." })),
      }),
    );
    const releases = yield* decodeGitHubReleaseIndex(body).pipe(
      Effect.mapError(
        () => new ReleaseIndexError({ reason: "The t3 release index had an unexpected shape." }),
      ),
    );
    const version = newestCliReleaseVersion(releases, channel);
    if (version !== undefined) return version;
    if (releases.length === 0) break;
  }
  return yield* new ReleaseIndexError({ reason: `No published ${channel} release was found.` });
});
