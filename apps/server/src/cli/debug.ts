import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { CPU_PROFILE_MAX_SECONDS } from "../diagnostics/CpuProfiler.ts";
import {
  CPU_PROFILE_ROUTE_PATH,
  CpuProfileErrorResponse,
  CpuProfileResponse,
} from "../diagnostics/cpuProfileRoute.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as CliAuthRuntime from "./cliAuthRuntime.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";
import { McpServerNotRunningError } from "./ownerMcpTools.ts";

export class DebugProfileError extends Schema.TaggedError<DebugProfileError>()(
  "DebugProfileError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const failReported = <E extends { readonly message: string }>(error: E) =>
  Console.error(error.message).pipe(Effect.andThen(Effect.fail(error)));

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

const requestProfile = Effect.fn("cli.debug.profile.request")(function* (
  origin: string,
  token: string,
  seconds: number,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(new URL(CPU_PROFILE_ROUTE_PATH, origin).href).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.bodyJson({ seconds }),
    Effect.flatMap(httpClient.execute),
    Effect.timeout(Duration.seconds(seconds + 60)),
    Effect.mapError(
      (cause) =>
        new DebugProfileError({
          detail: `Could not reach the T3 Code server at ${origin}.`,
          cause,
        }),
    ),
  );
  if (response.status >= 200 && response.status < 300) {
    return yield* HttpClientResponse.schemaBodyJson(CpuProfileResponse)(response).pipe(
      Effect.mapError(
        (cause) =>
          new DebugProfileError({
            detail: "The server sent an unexpected profile result. Update the t3 CLI to match it.",
            cause,
          }),
      ),
    );
  }
  const body = yield* HttpClientResponse.schemaBodyJson(CpuProfileErrorResponse)(response).pipe(
    Effect.option,
  );
  return yield* new DebugProfileError({
    detail: Option.match(body, {
      onNone: () =>
        response.status === 404
          ? "This server does not support CPU profiles. Update T3 Code on it."
          : `The server refused the profile (HTTP ${response.status}).`,
      onSome: (value) => value.error,
    }),
  });
});

const profileCommand = Command.make("profile", {
  baseDir: baseDirFlag,
  seconds: Flag.Int("seconds").pipe(
    Flag.withDescription(`How long to sample, 1 to ${CPU_PROFILE_MAX_SECONDS} seconds.`),
    Flag.withDefault(20),
  ),
  out: Flag.String("out").pipe(
    Flag.withDescription("Also copy the profile to this path."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Take a CPU profile of the running server. Open the .cpuprofile in Chrome DevTools or speedscope.",
  ),
  Command.withHandler(
    Effect.fn("cli.debug.profile")(function* (flags) {
      if (flags.seconds < 1 || flags.seconds > CPU_PROFILE_MAX_SECONDS) {
        return yield* failReported(
          new DebugProfileError({
            detail: `--seconds must be between 1 and ${CPU_PROFILE_MAX_SECONDS}.`,
          }),
        );
      }
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig({ baseDir: flags.baseDir }, logLevel, {
        quietLogs: true,
      });
      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        return yield* failReported(new McpServerNotRunningError({ baseDir: config.baseDir }));
      }
      const origin = runtimeState.value.origin;
      const result = yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        return yield* Effect.acquireUseRelease(
          environmentAuth.issueSession({
            scopes: [AuthEnvironmentMaintainScope],
            label: "t3 debug profile",
          }),
          (issued) =>
            requestProfile(origin, issued.token, flags.seconds).pipe(
              Effect.catchTags({ DebugProfileError: failReported }),
            ),
          (issued) =>
            environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
        );
      }).pipe(
        Effect.provide(
          CliAuthRuntime.layer.pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
          ),
        ),
      );
      let printedPath = result.path;
      if (Option.isSome(flags.out)) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        printedPath = path.resolve(flags.out.value);
        yield* fs.copyFile(result.path, printedPath);
      }
      yield* Console.log(`${printedPath} ${formatBytes(result.bytes)}`);
    }),
  ),
);

export const debugCommand = Command.make("debug").pipe(
  Command.withDescription("Debug the running T3 Code server."),
  Command.withSubcommands([profileCommand]),
);
