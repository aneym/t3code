import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { readAgentHomes } from "./agentHomeBindings";
import { assignAgentHomes } from "./agentMainThreadMenu";
import { railsAgentHandle } from "./railsAgents";

export async function bindAgentFirstOpen(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  workspaceRoot: string | null,
): Promise<void> {
  const handle = workspaceRoot ? railsAgentHandle(workspaceRoot) : null;
  if (!handle) return;
  const homes = readAgentHomes().filter((home) => home.handle === handle);
  if (
    !homes.some((home) => home.role === "orch" && home.environmentId === environmentId) ||
    homes.some((home) => home.binding !== null)
  )
    return;
  const failed = await assignAgentHomes({
    handle,
    target: { environmentId, threadId },
    environmentIds: [environmentId],
    onlyIfUnbound: true,
  });
  if (failed.length)
    toastManager.add({
      type: "error",
      title: `Could not bind ${handle}'s first thread`,
      description: "Use the thread menu to retry assigning its main thread.",
    });
}
