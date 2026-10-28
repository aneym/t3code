import * as Schema from "effect/Schema";
import {
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";

import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { shortcutLabelForCommand, threadJumpCommandForIndex } from "../../keybindings";
import { useProjects } from "../../state/entities";
import { type RailsAgent, useRailsAgents } from "./railsAgents";
import { sidebarProjectPinKey, useSidebarPins } from "./sidebarPins";

export const AGENTS_SECTION_STORAGE_KEY = "t3code:sidebar-section:agents:expanded";

export function useSidebarAgentLists(projectKeys: ReadonlySet<string> | null) {
  const inScope = (agent: RailsAgent) =>
    projectKeys === null || projectKeys.has(scopedProjectKey(agent.projectRef));
  const agents = useRailsAgents();
  const { pinnedKeys } = useSidebarPins();
  const projects = useProjects();
  const [expanded] = useLocalStorage(AGENTS_SECTION_STORAGE_KEY, true, Schema.Boolean);
  const agentByHandle = new Map(agents.map((agent) => [agent.handle, agent] as const));
  const pinned = pinnedKeys
    .flatMap((handle): RailsAgent[] => {
      const agent = agentByHandle.get(handle);
      if (agent) return [agent];
      const project = projects.find((entry) => sidebarProjectPinKey(entry) === handle);
      return project
        ? [
            {
              handle,
              name: project.title,
              projectRef: { environmentId: project.environmentId, projectId: project.id },
              environmentIds: [project.environmentId],
              thread: null,
            },
          ]
        : [];
    })
    .filter(inScope);
  const hidden = agents
    .filter((agent) => inScope(agent) && !pinnedKeys.includes(agent.handle))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return { pinned, hidden, jumpable: expanded ? pinned : [] };
}

export function sidebarAgentJumpKey(agent: RailsAgent): string {
  return agent.thread === null
    ? `agent:${agent.handle}`
    : scopedThreadKey(scopeThreadRef(agent.thread.environmentId, agent.thread.id));
}

export function sidebarJumpKeys(
  jumpable: ReadonlyArray<RailsAgent>,
  orderedThreadKeys: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [...new Set([...jumpable.map(sidebarAgentJumpKey), ...orderedThreadKeys])];
}

export function sidebarJumpLabels(
  jumpKeys: ReadonlyArray<string>,
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  for (const [index, key] of jumpKeys.entries()) {
    const command = threadJumpCommandForIndex(index);
    if (!command) break;
    const label = shortcutLabelForCommand(keybindings, command);
    if (label) mapping.set(key, label);
  }
  return mapping;
}
