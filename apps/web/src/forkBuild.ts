import * as Option from "effect/Option";

import { APP_VERSION } from "./branding";
import {
  decodeForkBuildManifest,
  decodeUpstreamReleases,
  parseForkVersion,
  resolveUpstreamNightlyStatus,
  type ForkBuildManifest,
  type UpstreamNightlyStatus,
} from "./forkBuild.logic";

const UPSTREAM_RELEASES_URL = "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=20";
const UPSTREAM_CACHE_MS = 15 * 60 * 1000;

export const FORK_VERSION = parseForkVersion(APP_VERSION);

let manifestRequest: Promise<ForkBuildManifest | null> | null = null;

export function loadForkBuildManifest(): Promise<ForkBuildManifest | null> {
  manifestRequest ??= fetch("/fork-build.json", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: unknown) => Option.getOrNull(decodeForkBuildManifest(body)))
    .catch(() => null);
  return manifestRequest;
}

let upstreamCheck: {
  readonly checkedAt: number;
  readonly request: Promise<UpstreamNightlyStatus | null>;
} | null = null;

export function checkUpstreamNightly(currentBuild: number): Promise<UpstreamNightlyStatus | null> {
  const now = Date.now();
  if (upstreamCheck !== null && now - upstreamCheck.checkedAt < UPSTREAM_CACHE_MS) {
    return upstreamCheck.request;
  }
  const request = fetch(UPSTREAM_RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then((response) => {
      if (!response.ok) throw new Error(`GitHub releases returned ${response.status}`);
      return response.json();
    })
    .then((body: unknown) => {
      const releases = decodeUpstreamReleases(body);
      if (Option.isNone(releases)) throw new Error("GitHub releases had an unexpected shape");
      return resolveUpstreamNightlyStatus(releases.value, currentBuild);
    })
    .catch(() => {
      if (upstreamCheck?.request === request) upstreamCheck = null;
      return null;
    });
  upstreamCheck = { checkedAt: now, request };
  return request;
}
