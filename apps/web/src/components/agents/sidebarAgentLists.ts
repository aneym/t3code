import * as Schema from "effect/Schema";
import {
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type {
  ResolvedKeybindingsConfig,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { shortcutLabelForCommand, threadJumpCommandForIndex } from "../../keybindings";
import { useProjects } from "../../state/entities";
import { type RailsAgent, railsAgentHandle, useRailsAgents } from "./railsAgents";
import { sidebarProjectPinKey, useSidebarPins } from "./sidebarPins";

export const AGENTS_SECTION_STORAGE_KEY = "t3code:sidebar-section:agents:expanded";

export function useSidebarAgentLists(projectKeys: ReadonlySet<string> | null) {
  const inScope = (agent: RailsAgent) =>
    projectKeys === null ||
    (agent.projectRef !== null && projectKeys.has(scopedProjectKey(agent.projectRef)));
  const agents = useRailsAgents();
  const pinnedKeys = [...new Set(useSidebarPins().pinnedKeys)];
  const projects = useProjects();
  const [expanded] = useLocalStorage(AGENTS_SECTION_STORAGE_KEY, true, Schema.Boolean);
  const agentByHandle = new Map(agents.map((agent) => [agent.handle, agent] as const));
  const pinned = pinnedKeys.flatMap((handle): RailsAgent[] => {
    const agent = agentByHandle.get(handle);
    if (agent) return [agent];
    const project = projects.find(
      (entry) =>
        sidebarProjectPinKey(entry) === handle && railsAgentHandle(entry.workspaceRoot) === null,
    );
    if (!project) return [];
    const projectRef = { environmentId: project.environmentId, projectId: project.id };
    return [
      {
        handle,
        name: project.title,
        projectRef,
        homeProjectRefs: [projectRef],
        environmentIds: [project.environmentId],
        target: null,
        remoteHost: null,
        projects: [],
        lanes: [],
        thread: null,
      },
    ];
  });
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

export function openSidebarJumpAgent(
  jumpable: ReadonlyArray<RailsAgent>,
  jumpKey: string | null,
  navigateToThread: (threadRef: ScopedThreadRef) => unknown,
  startThread: (projectRef: ScopedProjectRef) => unknown,
): boolean {
  const agent = jumpable.find((entry) => sidebarAgentJumpKey(entry) === jumpKey);
  const target = agent?.thread
    ? scopeThreadRef(agent.thread.environmentId, agent.thread.id)
    : agent?.target;
  if (target) void navigateToThread(target);
  else if (agent?.projectRef) void startThread(agent.projectRef);
  else return false;
  return true;
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
