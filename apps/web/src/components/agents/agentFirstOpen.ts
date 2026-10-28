import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { assignAgentHomes } from "./agentMainThreadMenu";
import type { RailsAgent } from "./railsAgents";

interface FirstOpenIntent {
  readonly handle: string;
  readonly environmentId: EnvironmentId;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly host: string;
}

const intents = new Map<ThreadId, FirstOpenIntent>();

export function rememberAgentFirstOpen(
  threadId: ThreadId,
  agent: RailsAgent,
  environmentId: EnvironmentId,
  host: string,
): void {
  intents.set(threadId, {
    handle: agent.handle,
    environmentId,
    environmentIds: agent.environmentIds,
    host,
  });
}

export async function bindAgentFirstOpen(
  threadId: ThreadId,
  environmentId: EnvironmentId,
): Promise<void> {
  const intent = intents.get(threadId);
  if (!intent || intent.environmentId !== environmentId) return;
  intents.delete(threadId);
  const failed = await assignAgentHomes({
    handle: intent.handle,
    target: { environmentId, threadId },
    environmentIds: intent.environmentIds,
    host: intent.host,
    onlyIfUnbound: true,
  });
  if (failed.length)
    toastManager.add({
      type: "error",
      title: `Could not bind ${intent.handle}'s first thread`,
      description: "Use the thread menu to retry assigning its main thread.",
    });
}
