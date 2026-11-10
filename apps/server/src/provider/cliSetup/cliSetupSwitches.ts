import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

export type CliSetupStep = "install" | "signIn";

export const cliSetupEnabled = Effect.fn("cliSetupEnabled")(function* (
  driver: string,
  step: CliSetupStep,
) {
  const environment = yield* HostProcess.Environment;
  const off = (environment.T3CODE_PROVIDER_CLI_SETUP_OFF ?? "")
    .split(",")
    .map((entry) => entry.trim());
  return !off.includes(`${driver}:${step}`);
});
