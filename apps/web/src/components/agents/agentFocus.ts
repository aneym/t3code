import * as Schema from "effect/Schema";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { FocusIcon } from "lucide-react";
import { useEffect } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects } from "../../state/entities";
import { threadFamilies } from "../../state/threads";
import {
  type RailsAgent,
  railsAgentHandle,
  railsAgentThreadKey,
  useRailsAgents,
} from "./railsAgents";

const AGENT_FOCUS_STORAGE_KEY = "t3code:sidebar-agent-focus";
const agentFocusSchema = Schema.NullOr(Schema.String);

export function useAgentFocusHandle() {
  return useLocalStorage(AGENT_FOCUS_STORAGE_KEY, null, agentFocusSchema);
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
): { readonly threads: ReadonlyArray<T>; readonly projectKeys: ReadonlySet<string> | null } {
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
  const laneKey = JSON.stringify(focused?.lanes ?? []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds settled lane threads outside the shell window in the rows while their agent is focused
  useEffect(() => {
    const releases = (JSON.parse(laneKey) as ScopedThreadRef[]).map((lane) =>
      threadFamilies.mount(appAtomRegistry, lane.environmentId, lane.threadId),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [laneKey]);
  if (!focused) return { threads: listed, projectKeys: null };
  const projectKeys = agentWorkProjectKeys(focused, projects);
  const laneKeys = new Set(focused.lanes.map((lane) => `${lane.environmentId}:${lane.threadId}`));
  return {
    threads: listed.filter(
      (thread) =>
        projectKeys.has(`${thread.environmentId}:${thread.projectId}`) ||
        laneKeys.has(railsAgentThreadKey(thread)) ||
        laneKeys.has(`${thread.environmentId}:${thread.lineage.rootThreadId}`),
    ),
    projectKeys,
  };
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
