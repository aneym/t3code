import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { isAppleGitPlaceholder } from "@t3tools/shared/appleGitPlaceholder";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { XcodeGitLocation } from "@t3tools/shared/shell";
import { withGitStandIn } from "./GitStandIn.ts";

export const commandEnv = (options: ChildProcess.CommandOptions) => {
  const merged = options.extendEnv
    ? { ...process.env, ...options.env }
    : (options.env ?? process.env);
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
};

const refusal = (command: ChildProcess.StandardCommand) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: command.command,
    description: "git is not installed",
  });

export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const upstream = yield* ChildProcessSpawner.ChildProcessSpawner;
    if ((yield* HostProcess.Platform) !== "darwin") return upstream;
    const locateXcodeGit = yield* XcodeGitLocation;
    return ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return upstream.spawn(command);
      const env = commandEnv(command.options);
      if (isAppleGitPlaceholder(command.command, env, locateXcodeGit)) {
        return Effect.fail(refusal(command));
      }
      const next = withGitStandIn(env, locateXcodeGit);
      return upstream.spawn(
        next === env
          ? command
          : ChildProcess.make(command.command, command.args, {
              ...command.options,
              env: next,
              extendEnv: false,
            }),
      );
    });
  }),
);
