import { createAgentHomesAtoms } from "@t3tools/client-runtime/state/agent-homes";
import { RAILS_AGENT_ID_PATTERN, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "../state/query";
import { readRailsWordsState, useRailsWordsState } from "./railsWordsState";

const agentHomes = createAgentHomesAtoms(connectionAtomRuntime);
const warnedHomes = new Set<string>();

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
    const agent = home.railsAgentId;
    if (agent === undefined || !RAILS_AGENT_ID_PATTERN.test(agent)) {
      const key = `${input.environmentId}:${home.handle}`;
      if (!warnedHomes.has(key)) {
        warnedHomes.add(key);
        console.warn(`[rails-words] not sent: agent ${home.handle} has no valid rails.agent_id`);
      }
      return;
    }
    bridge.said({
      environmentId: input.environmentId,
      threadId: input.threadId,
      agent,
      messageId: input.messageId,
      text: input.text,
      typedAt: input.typedAt,
    });
  } catch {
    return;
  }
}
