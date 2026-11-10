import type { ProviderInstallState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import { CLI_INSTALL_DRIVERS, CliInstallations } from "./cliSetup/CliInstallations.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

export const layerProviderInstallations = Layer.mergeAll(
  AntigravityInstallation.AntigravityInstallation.layer,
  CodexInstallation.CodexInstallation.layer,
  CliInstallations.layer,
);

const installedVersionChanges = (changes: Stream.Stream<ProviderInstallState>) =>
  changes.pipe(
    Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
    Stream.drop(1),
  );

export const layerProviderInstallationRefresh = Layer.effectDiscard(
  Effect.gen(function* () {
    const antigravity = yield* AntigravityInstallation.AntigravityInstallation;
    const codex = yield* CodexInstallation.CodexInstallation;
    const cli = yield* CliInstallations;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const cliChanges = CLI_INSTALL_DRIVERS.flatMap((driver) => {
      const runner = cli.runnerFor(driver);
      return runner ? [runner.changes] : [];
    });
    yield* Stream.mergeAll(
      [antigravity.changes, codex.changes, ...cliChanges].map(installedVersionChanges),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach((state) =>
        instances.listInstances.pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((instance) => instance.driverKind === state.driver),
              (instance) => providers.refreshInstance(instance.instanceId),
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
