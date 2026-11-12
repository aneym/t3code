import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const createProviderInstallAtoms = <R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) => ({
  providerInstallState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:provider:install-state",
    tag: WS_METHODS.providerInstallSubscribe,
    idleTtlMs: 0,
  }),
  startProviderInstall: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:provider:install-start",
    tag: WS_METHODS.providerInstallStart,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => JSON.stringify([environmentId, input.instanceId]),
    },
  }),
  cancelProviderInstall: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:provider:install-cancel",
    tag: WS_METHODS.providerInstallCancel,
  }),
  removeProviderInstallation: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:provider:install-remove",
    tag: WS_METHODS.providerInstallRemove,
  }),
});
