// @effect-diagnostics nodeBuiltinImport:off
import * as NodeInspector from "node:inspector";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

export const CPU_PROFILE_MAX_SECONDS = 120;

class CpuProfileBusyError extends Schema.TaggedError<CpuProfileBusyError>()(
  "CpuProfileBusyError",
  {},
) {
  override get message(): string {
    return "A CPU profile is already running on this server. Retry when it finishes.";
  }
}

class CpuProfileFailedError extends Schema.TaggedError<CpuProfileFailedError>()(
  "CpuProfileFailedError",
  { step: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    const reason = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `CPU profile failed at ${this.step}.${reason}`;
  }
}

interface CpuProfileResult {
  readonly path: string;
  readonly bytes: number;
  readonly seconds: number;
}

export class CpuProfiler extends Context.Service<
  CpuProfiler,
  {
    readonly capture: (
      seconds: number,
    ) => Effect.Effect<CpuProfileResult, CpuProfileBusyError | CpuProfileFailedError>;
  }
>()("t3/diagnostics/CpuProfiler") {}

const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const post = (session: NodeInspector.Session, method: string) =>
  Effect.callback<object, CpuProfileFailedError>((resume) => {
    session.post(method, (error, result) =>
      resume(
        error === null
          ? Effect.succeed(result ?? {})
          : Effect.fail(new CpuProfileFailedError({ step: method, cause: error })),
      ),
    );
  });

const openSession = Effect.acquireRelease(
  Effect.try({
    try: () => {
      const session = new NodeInspector.Session();
      session.connect();
      return session;
    },
    catch: (cause) => new CpuProfileFailedError({ step: "connect", cause }),
  }),
  (session) => Effect.sync(() => session.disconnect()),
);

const clampProfileSeconds = (seconds: number) =>
  Math.min(CPU_PROFILE_MAX_SECONDS, Math.max(1, Math.round(seconds)));

export const make = Effect.fn("makeCpuProfiler")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const permit = yield* Semaphore.make(1);
  const profilesDir = path.join(config.logsDir, "profiles");

  const record = Effect.fn("CpuProfiler.record")(function* (seconds: number) {
    const session = yield* openSession;
    yield* post(session, "Profiler.enable");
    yield* post(session, "Profiler.start");
    yield* Effect.sleep(Duration.seconds(seconds));
    const stopped = yield* post(session, "Profiler.stop");
    const profile = "profile" in stopped ? stopped.profile : undefined;
    if (profile === undefined) {
      return yield* new CpuProfileFailedError({
        step: "Profiler.stop",
        cause: new Error("The inspector returned no profile."),
      });
    }
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    const filePath = path.join(profilesDir, `cpu-${stamp}.cpuprofile`);
    const body = yield* encodeProfile(profile).pipe(
      Effect.mapError((cause) => new CpuProfileFailedError({ step: "encode", cause })),
    );
    yield* fs.makeDirectory(profilesDir, { recursive: true });
    yield* fs.writeFileString(filePath, body);
    return { path: filePath, bytes: Buffer.byteLength(body), seconds } satisfies CpuProfileResult;
  }, Effect.scoped);

  const capture = Effect.fn("CpuProfiler.capture")(function* (seconds: number) {
    const result = yield* record(clampProfileSeconds(seconds)).pipe(
      Effect.catchTags({
        PlatformError: (cause) => Effect.fail(new CpuProfileFailedError({ step: "write", cause })),
      }),
      permit.withPermitsIfAvailable(1),
    );
    if (Option.isNone(result)) return yield* new CpuProfileBusyError();
    return result.value;
  });

  return CpuProfiler.of({ capture });
});
