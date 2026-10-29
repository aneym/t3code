import * as Schema from "effect/Schema";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { FocusIcon } from "lucide-react";
import { useEffect } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  buildPhysicalToLogicalProjectKeyMap,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { threadFamilies } from "../../state/threads";
import {
  type RailsAgent,
  railsAgentHandle,
  railsAgentThreadKey,
  useRailsAgents,
} from "./railsAgents";
import { sidebarProjectPinKey } from "./sidebarPins";

const AGENT_FOCUS_STORAGE_KEY = "t3code:sidebar-agent-focus";
const agentFocusSchema = Schema.NullOr(Schema.String);

export function useAgentFocusHandle() {
  return useLocalStorage(AGENT_FOCUS_STORAGE_KEY, null, agentFocusSchema);
}

function agentWorkProjectKeys(agent: RailsAgent) {
  return new Set([
    ...agent.homeProjectRefs.map(scopedProjectKey),
    ...agent.workProjects.map((project) =>
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
    ),
  ]);
}

export function useSidebarAgentThreads<T extends EnvironmentThreadShell>(
  threads: ReadonlyArray<T>,
  groups: ReadonlyArray<SidebarProjectSnapshot>,
): {
  readonly threads: ReadonlyArray<T>;
  readonly projectKeys: ReadonlySet<string> | null;
  readonly scopeKeys: ReadonlyArray<string> | null;
} {
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
  const pinnedProject = focused
    ? undefined
    : projects.find((project) => handle !== null && sidebarProjectPinKey(project) === handle);
  if (!focused && !pinnedProject) return { threads: listed, projectKeys: null, scopeKeys: null };
  const ownProjectKeys = focused
    ? agentWorkProjectKeys(focused)
    : new Set(
        pinnedProject
          ? [scopedProjectKey(scopeProjectRef(pinnedProject.environmentId, pinnedProject.id))]
          : [],
      );
  const scopeProjects = focused
    ? new Set(focused.workProjects.map((project) => `${project.environmentId}:${project.id}`))
    : ownProjectKeys;
  const scopeGroups = groups.filter((group) =>
    group.memberProjectRefs.some((ref) => scopeProjects.has(scopedProjectKey(ref))),
  );
  const scopeKeys = scopeGroups.map((group) => group.projectKey);
  const projectKeys = new Set([
    ...ownProjectKeys,
    ...scopeGroups.flatMap((group) => group.memberProjectRefs.map(scopedProjectKey)),
  ]);
  const laneKeys = new Set(
    (focused?.lanes ?? []).map((lane) => `${lane.environmentId}:${lane.threadId}`),
  );
  return {
    threads: listed.filter(
      (thread) =>
        projectKeys.has(`${thread.environmentId}:${thread.projectId}`) ||
        laneKeys.has(railsAgentThreadKey(thread)) ||
        laneKeys.has(`${thread.environmentId}:${thread.lineage.rootThreadId}`),
    ),
    projectKeys,
    scopeKeys,
  };
}

export function withoutAgentHomes<T extends Pick<EnvironmentProject, "workspaceRoot">>(
  groups: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return groups.filter((group) => railsAgentHandle(group.workspaceRoot) === null);
}

export function useAgentFocusAction(setProjectScope: (keys: readonly string[]) => void) {
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [focused, setFocused] = useAgentFocusHandle();
  return (agent: RailsAgent) => {
    const active = focused === agent.handle;
    return {
      label: active ? "Show all threads" : `Focus ${agent.name}`,
      icon: FocusIcon,
      active,
      onClick: () => {
        if (active) return setProjectScope([]);
        const groupKeys = buildPhysicalToLogicalProjectKeyMap({
          projects,
          settings,
          primaryEnvironmentId,
        });
        setProjectScope([
          ...new Set(
            agent.workProjects.flatMap(
              (project) => groupKeys.get(derivePhysicalProjectKey(project)) ?? [],
            ),
          ),
        ]);
        setFocused(agent.handle);
      },
    };
  };
}

export function agentScopeProjectKeys(groups: ReadonlyArray<SidebarProjectSnapshot>) {
  return groups.length === 0
    ? null
    : new Set(groups.flatMap((group) => group.memberProjectRefs.map(scopedProjectKey)));
}
