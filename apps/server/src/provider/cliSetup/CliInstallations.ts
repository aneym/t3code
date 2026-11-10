import { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeClaudeCliInstallation } from "./ClaudeCliInstallation.ts";
import type { CliInstallRunner } from "./cliInstallRunner.ts";
import { makeCodexCliInstallation } from "./CodexCliInstallation.ts";

export const CLI_INSTALL_DRIVERS = [
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
] as const;

export class CliInstallations extends Context.Service<
  CliInstallations,
  { readonly runnerFor: (driver: ProviderDriverKind) => CliInstallRunner | undefined }
>()("t3/provider/cliSetup/CliInstallations") {
  static readonly layer = Layer.effect(
    CliInstallations,
    Effect.gen(function* () {
      const runners = new Map<ProviderDriverKind, CliInstallRunner>([
        [CLI_INSTALL_DRIVERS[0], yield* makeClaudeCliInstallation()],
        [CLI_INSTALL_DRIVERS[1], yield* makeCodexCliInstallation()],
      ]);
      return { runnerFor: (driver) => runners.get(driver) };
    }),
  );
}
