import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { readLoadedAgentHomes } from "./agentHomeBindings";
import { assignAgentHomes } from "./agentMainThreadMenu";

export async function bindAgentFirstOpen(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  workspaceRoot: string | null,
): Promise<void> {
  if (workspaceRoot === null) return;
  const root = workspaceRoot.replace(/\/$/, "");
  const loaded = readLoadedAgentHomes();
  const home = loaded?.find(
    (entry) =>
      entry.environmentId === environmentId &&
      entry.role === "orch" &&
      entry.workspaceRoot.replace(/\/$/, "") === root,
  );
  if (!loaded || !home) return;
  const handle = home.handle;
  if (loaded.some((entry) => entry.handle === handle && entry.binding !== null)) return;
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
