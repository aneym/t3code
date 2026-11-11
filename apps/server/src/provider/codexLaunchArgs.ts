import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";

import * as GitStandIn from "../vcs/GitStandIn.ts";
import { configuredCodexBaseUrl } from "./codexBaseUrl.ts";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  settings: { readonly launchArgs?: string; readonly baseUrl?: string },
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const launchArgs =
    environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || settings.launchArgs?.trim() || "";
  const baseUrl = configuredCodexBaseUrl(settings.baseUrl);
  if (!baseUrl) return launchArgs;
  return `${launchArgs} -c ${JSON.stringify(`openai_base_url=${JSON.stringify(baseUrl)}`)}`.trim();
};

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexAppServerArgsFor = Effect.fn("codexAppServerArgsFor")(function* (
  launchArgs: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const gitStandIn = (yield* GitStandIn.environment(environment)) !== environment;
  return [
    ...codexAppServerArgs(launchArgs),
    ...(gitStandIn ? ["--config", "features.plugins=false"] : []),
  ];
});

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
