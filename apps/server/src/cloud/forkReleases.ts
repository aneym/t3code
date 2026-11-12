import { ForkReleaseList, IsoDateTime, ServerSelfUpdateError } from "@t3tools/contracts";
import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { pinnedRuntimeVersionsDir } from "./pinnedRuntime.ts";
import { compareExactServiceVersions, isExactServiceVersion } from "./serviceProtocol.ts";

const Manifest = Schema.Struct({
  releases: Schema.Array(
    Schema.Struct({
      version: Schema.String,
      builtAt: IsoDateTime,
      cli: Schema.Array(Schema.String),
      desktop: Schema.Array(Schema.String),
    }),
  ),
});

function isForkVersion(version: string): boolean {
  return isExactServiceVersion(version) && /\.aneym\.\d+$/.test(version);
}

export class ForkReleases extends Context.Service<
  ForkReleases,
  {
    readonly list: () => Effect.Effect<ForkReleaseList, ServerSelfUpdateError>;
  }
>()("t3/cloud/forkReleases") {}

export const layer = Layer.effect(
  ForkReleases,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const baseUrl = yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option);

    return ForkReleases.of({
      list: Effect.fn("ForkReleases.list")(function* () {
        if (Option.isNone(baseUrl) || baseUrl.value.trim() === "") {
          return { releases: [], reason: "No fork release feed is configured." };
        }
        return yield* Effect.gen(function* () {
          const manifest = yield* http
            .get(`${baseUrl.value.replace(/\/+$/, "")}/releases.json`)
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(Manifest)),
              Effect.timeout("30 seconds"),
            );
          const available = manifest.releases
            .filter(
              (release) =>
                isForkVersion(release.version) && release.cli.includes(`${platform}-${arch}`),
            )
            .toSorted((a, b) => compareExactServiceVersions(b.version, a.version));
          const latest = available[0]?.version;
          const versionsDir = pinnedRuntimeVersionsDir(path, config.baseDir);
          const entries = yield* fs.readDirectory(versionsDir).pipe(Effect.orElseSucceed(() => []));
          const cached = new Map<string, string>();
          yield* Effect.forEach(
            entries.filter(isForkVersion),
            (version) =>
              Effect.gen(function* () {
                const sentinel = path.join(versionsDir, version, ".install-complete");
                const contents = yield* fs.readFileString(sentinel).pipe(Effect.option);
                if (Option.isNone(contents) || contents.value.trim() !== version) return;
                const executable = path.join(
                  versionsDir,
                  version,
                  platform === "win32" ? "t3.exe" : "t3",
                );
                if (!(yield* fs.exists(executable))) return;
                const info = yield* fs.stat(sentinel);
                cached.set(
                  version,
                  Option.match(info.mtime, {
                    onNone: () => "1970-01-01T00:00:00.000Z",
                    onSome: (time) => time.toISOString(),
                  }),
                );
              }),
            { concurrency: "unbounded" },
          );
          const releases = new Map(
            available.map((release) => [
              release.version,
              {
                version: release.version,
                builtAt: release.builtAt,
                desktop: release.desktop,
                current: release.version === packageJson.version,
                latest: release.version === latest,
                cached: cached.has(release.version),
              },
            ]),
          );
          for (const [version, builtAt] of cached) {
            if (!releases.has(version))
              releases.set(version, {
                version,
                builtAt,
                desktop: [],
                current: version === packageJson.version,
                latest: false,
                cached: true,
              });
          }
          return {
            releases: [...releases.values()].toSorted((a, b) =>
              compareExactServiceVersions(b.version, a.version),
            ),
          };
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSelfUpdateError({
                reason: "Could not list fork releases.",
                cause,
              }),
          ),
        );
      }),
    });
  }),
);
