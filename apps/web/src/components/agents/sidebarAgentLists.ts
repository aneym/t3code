import * as Schema from "effect/Schema";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ResolvedKeybindingsConfig, ScopedProjectRef } from "@t3tools/contracts";
import { FocusIcon } from "lucide-react";

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
  const pinned = pinnedKeys
    .flatMap((handle): RailsAgent[] => {
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
          thread: null,
        },
      ];
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

export interface AgentProjectScope {
  readonly keys: ReadonlyArray<string>;
  readonly groups: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
  }>;
  readonly set: (keys: ReadonlyArray<string>) => void;
}

const folderName = (workspaceRoot: string) =>
  workspaceRoot.replace(/\/+$/, "").split("/").at(-1)?.toLowerCase() ?? "";

export function agentFocusAction(
  agent: RailsAgent,
  scope: AgentProjectScope,
  projects: ReadonlyArray<EnvironmentProject>,
) {
  if (agent.homeProjectRefs.length === 0) return null;
  const declared = new Set(agent.projects.map((name) => name.toLowerCase()));
  const projectKeys = new Set([
    ...agent.homeProjectRefs.map(scopedProjectKey),
    ...projects
      .filter(
        (project) =>
          declared.has(project.title.toLowerCase()) ||
          declared.has(folderName(project.workspaceRoot)),
      )
      .map((project) => scopedProjectKey(scopeProjectRef(project.environmentId, project.id))),
  ]);
  const keys = scope.groups
    .filter((group) =>
      group.memberProjectRefs.some((ref) => projectKeys.has(scopedProjectKey(ref))),
    )
    .map((group) => group.projectKey);
  if (keys.length === 0) return null;
  const active = keys.length === scope.keys.length && keys.every((key) => scope.keys.includes(key));
  return {
    label: active ? "Show all projects" : `Focus ${agent.name}`,
    icon: FocusIcon,
    active,
    onClick: () => scope.set(active ? [] : keys),
  };
}
