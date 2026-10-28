import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import { useAutomationThreadKeys } from "../../hooks/useAutomations";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { isAutomationOnlyThread } from "../automations/threadPlacement";
import { toastManager } from "../ui/toast";
import { bindAgentHome } from "./agentHomeBindings";
import { railsAgentHandle, useRailsAgents } from "./railsAgents";

export interface AgentMainThreadOption {
  readonly handle: string;
  readonly name: string;
  readonly isCurrent: boolean;
}

export async function assignAgentHomes(input: {
  readonly handle: string;
  readonly target: ScopedThreadRef;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly host: string;
  readonly onlyIfUnbound?: boolean;
}): Promise<ReadonlyArray<EnvironmentId>> {
  const failed: EnvironmentId[] = [];
  for (const environmentId of input.environmentIds.toSorted()) {
    const result = await runAtomCommand(appAtomRegistry, bindAgentHome, {
      environmentId,
      input: {
        handle: input.handle,
        threadId: input.target.threadId,
        threadEnvironmentId: input.target.environmentId,
        host: input.host,
        by: input.onlyIfUnbound ? "t3-first-open" : "t3-menu",
        ...(input.onlyIfUnbound ? { onlyIfUnbound: true } : {}),
      },
    });
    if (result._tag === "Failure") {
      failed.push(environmentId);
      if (input.onlyIfUnbound) break;
    } else if (
      input.onlyIfUnbound &&
      (result.value.home.binding?.threadId !== input.target.threadId ||
        result.value.home.binding.environmentId !== input.target.environmentId)
    ) {
      break;
    }
  }
  return failed;
}

export function useAgentMainThreadMenu() {
  const agents = useRailsAgents();
  const projects = useProjects();
  const automationThreadKeys = useAutomationThreadKeys();
  const environments = useEnvironmentIdentities();
  return {
    options(thread: EnvironmentThreadShell): ReadonlyArray<AgentMainThreadOption> {
      if (
        thread.lineage.parentThreadId !== null ||
        isAutomationOnlyThread(thread, automationThreadKeys)
      )
        return [];
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      );
      const homeHandle = project ? railsAgentHandle(project.workspaceRoot) : null;
      return agents
        .filter(
          (agent) =>
            (homeHandle === null || agent.handle === homeHandle) &&
            agent.environmentIds.every((id) => readEnvironmentScope(id, AuthFilesystemWriteScope)),
        )
        .map((agent) => ({
          handle: agent.handle,
          name: agent.name,
          isCurrent:
            agent.target?.environmentId === thread.environmentId &&
            agent.target.threadId === thread.id,
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
    },
    async assign(handle: string, thread: EnvironmentThreadShell): Promise<void> {
      const agent = agents.find((entry) => entry.handle === handle);
      if (
        !agent ||
        thread.lineage.parentThreadId !== null ||
        isAutomationOnlyThread(thread, automationThreadKeys)
      )
        return;
      const host =
        environments
          .find((entry) => entry.environmentId === thread.environmentId)
          ?.label.toLowerCase() ?? thread.environmentId;
      const failed = await assignAgentHomes({
        handle,
        target: { environmentId: thread.environmentId, threadId: thread.id },
        environmentIds: agent.environmentIds,
        host,
      });
      toastManager.add(
        failed.length
          ? {
              type: "error",
              title: `Could not update all homes for ${agent.name}`,
              description: failed
                .map((id) => environments.find((entry) => entry.environmentId === id)?.label ?? id)
                .join(", "),
            }
          : { type: "success", title: `${thread.title} is now ${agent.name}'s main thread` },
      );
    },
  };
}
