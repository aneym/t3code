import * as Schema from "effect/Schema";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { FocusIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useProjects } from "../../state/entities";
import {
  type RailsAgent,
  railsAgentHandle,
  railsAgentThreadKey,
  useRailsAgents,
} from "./railsAgents";

const AGENT_FOCUS_STORAGE_KEY = "t3code:sidebar-agent-focus";

export function useAgentFocusHandle() {
  return useLocalStorage(AGENT_FOCUS_STORAGE_KEY, null, Schema.NullOr(Schema.String));
}

const folderName = (workspaceRoot: string) =>
  workspaceRoot
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase() ?? "";

function agentWorkProjectKeys(agent: RailsAgent, projects: ReadonlyArray<EnvironmentProject>) {
  const declared = new Set(agent.projects.map((name) => name.toLowerCase()));
  return new Set([
    ...agent.homeProjectRefs.map(scopedProjectKey),
    ...projects
      .filter(
        (project) =>
          declared.has(project.title.toLowerCase()) ||
          declared.has(folderName(project.workspaceRoot)),
      )
      .map((project) => scopedProjectKey(scopeProjectRef(project.environmentId, project.id))),
  ]);
}

export function useSidebarAgentThreads<T extends EnvironmentThreadShell>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const agents = useRailsAgents();
  const projects = useProjects();
  const [handle] = useAgentFocusHandle();
  const mainKeys = new Set(
    agents.flatMap((agent) =>
      agent.target ? [`${agent.target.environmentId}:${agent.target.threadId}`] : [],
    ),
  );
  const listed = threads.filter((thread) => !mainKeys.has(railsAgentThreadKey(thread)));
  const focused = agents.find((agent) => agent.handle === handle);
  if (!focused) return listed;
  const projectKeys = agentWorkProjectKeys(focused, projects);
  const laneKeys = new Set(focused.lanes.map((lane) => `${lane.environmentId}:${lane.threadId}`));
  return listed.filter(
    (thread) =>
      projectKeys.has(`${thread.environmentId}:${thread.projectId}`) ||
      laneKeys.has(railsAgentThreadKey(thread)) ||
      laneKeys.has(`${thread.environmentId}:${thread.lineage.rootThreadId}`),
  );
}

export function withoutAgentHomes<T extends Pick<EnvironmentProject, "workspaceRoot">>(
  groups: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return groups.filter((group) => railsAgentHandle(group.workspaceRoot) === null);
}

export function agentFocusAction(
  agent: RailsAgent,
  focused: string | null,
  setFocused: (handle: string | null) => void,
  clearProjectScope: () => void,
) {
  const active = focused === agent.handle;
  return {
    label: active ? "Show all threads" : `Focus ${agent.name}`,
    icon: FocusIcon,
    active,
    onClick: () => {
      if (active) return setFocused(null);
      clearProjectScope();
      setFocused(agent.handle);
    },
  };
}
