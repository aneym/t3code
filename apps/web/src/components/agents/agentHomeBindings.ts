import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type AgentHome, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentIds } from "../../state/environments";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";

export const bindAgentHome = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web-agents:bind",
  tag: WS_METHODS.agentsBind,
});

const subscribeHomes = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "web-agents:homes",
  tag: WS_METHODS.agentsSubscribeHomes,
});

export interface EnvironmentAgentHome extends AgentHome {
  readonly environmentId: EnvironmentId;
}

const environmentHomes = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<EnvironmentAgentHome> => {
    const result = get(subscribeHomes({ environmentId, input: {} }));
    const snapshot = Option.getOrNull(AsyncResult.value(result));
    return snapshot?.homes.map((home) => ({ ...home, environmentId })) ?? [];
  }),
);
const allHomes = environmentAtomList("web-agents:all-homes", environmentHomes);

export function useAgentHomes(): ReadonlyArray<EnvironmentAgentHome> {
  const ids = useEnvironmentIds().toSorted();
  return useAtomValue(allHomes(environmentIdsKey(ids))).flat();
}
