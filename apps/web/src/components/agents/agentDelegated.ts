import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { useDelegatedUnderParent, useQuietThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { environmentSummaries } from "../../state/presentation";
import { readLoadedAgentHomes, useAgentHomes } from "./agentHomeBindings";
import { agentMainThreadKeys } from "./railsAgents";

interface DelegatedThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly delegatedFrom?:
    | { readonly environmentId: string; readonly threadId: string }
    | null
    | undefined;
  readonly pinnedAt?: unknown;
}

export function delegatedFromAgentMain(
  thread: Pick<DelegatedThread, "delegatedFrom">,
  mainKeys: ReadonlySet<string>,
) {
  const parent = thread.delegatedFrom;
  return parent != null && mainKeys.has(`${parent.environmentId}:${parent.threadId}`);
}

export function delegatedOutsideAgentMains(
  delegated: ReadonlySet<string>,
  threads: ReadonlyArray<DelegatedThread>,
  mainKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const listed = threads
    .filter((thread) => thread.pinnedAt != null || delegatedFromAgentMain(thread, mainKeys))
    .map((thread) => `${thread.environmentId}:${thread.id}`)
    .filter((key) => delegated.has(key));
  if (listed.length === 0) return delegated;
  const next = new Set(delegated);
  for (const key of listed) next.delete(key);
  return next;
}

export function readAgentMainThreadKeys(registry: AtomRegistry.AtomRegistry) {
  return agentMainThreadKeys(
    readLoadedAgentHomes() ?? [],
    registry.get(environmentSummaries.identitiesAtom),
  );
}

export function useListedDelegatedUnderParent(): ReadonlySet<string> {
  const delegated = useDelegatedUnderParent();
  const threads = useQuietThreadShells();
  const mainKeys = agentMainThreadKeys(useAgentHomes(), useEnvironmentIdentities());
  return delegatedOutsideAgentMains(delegated, threads, mainKeys);
}
