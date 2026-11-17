import { createAgentHomesAtoms } from "@t3tools/client-runtime/state/agent-homes";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "../state/query";
import { readRailsWordsState, useRailsWordsState } from "./railsWordsState";

const agentHomes = createAgentHomesAtoms(connectionAtomRuntime);

export function useRailsWordsAgentHomes(environmentId: EnvironmentId | null, enabled: boolean) {
  const connected = useRailsWordsState()?.connected === true;
  useEnvironmentQuery(
    enabled && connected && environmentId !== null
      ? agentHomes.homes({ environmentId, input: null })
      : null,
  );
}

export function reportSaid(input: {
  readonly typedAt: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
}): void {
  try {
    const bridge = window.desktopBridge?.railsWords;
    if (!bridge || input.typedAt === null) return;
    if (!getClientSettings().railsWordsEnabled || readRailsWordsState()?.connected !== true) return;
    const snapshot = AsyncResult.getOrElse(
      appAtomRegistry.get(agentHomes.homes({ environmentId: input.environmentId, input: null })),
      () => null,
    );
    const home = snapshot?.homes.find(
      (candidate) =>
        candidate.binding?.threadId === input.threadId &&
        (candidate.binding.environmentId === null ||
          candidate.binding.environmentId === input.environmentId),
    );
    if (home === undefined) return;
    bridge.said({
      environmentId: input.environmentId,
      threadId: input.threadId,
      agent: home.handle,
      messageId: input.messageId,
      text: input.text,
      typedAt: input.typedAt,
    });
  } catch {
    return;
  }
}
