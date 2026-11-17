import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export function createAgentHomesAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    homes: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:agents:homes",
      subscribe: (_input: null) => subscribe(WS_METHODS.agentsSubscribeHomes, {}),
    }),
  };
}
