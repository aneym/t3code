import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const createStorageCleanupAtoms = <R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) => ({
  runStorageCleanup: createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:run-storage-cleanup",
    tag: WS_METHODS.serverRunStorageCleanup,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
  }),
  storageCleanupReport: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:server:storage-cleanup-report",
    tag: WS_METHODS.serverSubscribeStorageCleanupReport,
    idleTtlMs: 0,
  }),
});
