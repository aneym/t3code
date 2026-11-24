import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

export const deviceHostEnvironment = (
  environment: NodeJS.ProcessEnv,
  sdkRoot: string | null,
  hostPlatform: NodeJS.Platform,
  path: Path.Path,
  developerDir: string,
): NodeJS.ProcessEnv => {
  const base = developerDir ? { ...environment, DEVELOPER_DIR: developerDir } : environment;
  return sdkRoot
    ? {
        ...base,
        ANDROID_HOME: sdkRoot,
        PATH: [
          path.join(sdkRoot, "platform-tools"),
          path.join(sdkRoot, "emulator"),
          environment.PATH ?? environment.Path ?? "",
        ].join(hostPlatform === "win32" ? ";" : ":"),
      }
    : base;
};

export const hubEnvironment = Effect.fn("LocalDeviceHost.hubEnvironment")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const env: NodeJS.ProcessEnv = { ...environment, FORCE_COLOR: "0", NO_COLOR: "1" };
  const platform = yield* HostProcess.Platform;
  const uid = yield* HostProcess.UserId;
  if (env.ANDROID_HOME) {
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const emulator = path.join(
      env.ANDROID_HOME,
      "emulator",
      platform === "win32" ? "emulator.exe" : "emulator",
    );
    const cameraArgs = yield* Effect.forEach(["front", "back"], (facing) =>
      runner
        .run({
          command: emulator,
          args: [`-help-camera-${facing}`],
          env,
          timeout: Duration.seconds(5),
        })
        .pipe(
          Effect.map((result) => {
            const help = `${result.stdout}\n${result.stderr}`;
            // The hub wires imagefile cameras unconditionally; older SDK emulators reject that mode.
            return result.code === 0 && /\bemulated\b/.test(help) && !/\bimagefile\b/.test(help)
              ? `-camera-${facing} emulated`
              : "";
          }),
          Effect.orElseSucceed(() => ""),
        ),
    );
    const overrides = cameraArgs.filter(Boolean).join(" ");
    if (overrides) {
      env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS = [overrides, env.EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS]
        .filter(Boolean)
        .join(" ");
    }
  }
  if (platform === "linux" && env.XDG_RUNTIME_DIR === undefined && uid !== undefined) {
    // SSH sessions may omit the directory where the emulator publishes its gRPC token.
    const runtimeDir = `/run/user/${uid}`;
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(runtimeDir).pipe(Effect.option);
    if (
      stat._tag === "Some" &&
      stat.value.type === "Directory" &&
      Option.contains(stat.value.uid, uid)
    ) {
      env.XDG_RUNTIME_DIR = runtimeDir;
    }
  }
  return env;
});
