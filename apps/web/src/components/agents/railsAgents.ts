import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";

import { useProjects, useQuietThreadShells } from "../../state/entities";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { useAgentHomeBoundThreadIds } from "./agentHomeBindings";

const AGENT_HOME_PATTERN = /\/\.agent-rails\/agents\/([a-z0-9][a-z0-9-]*)\/?$/;

export interface RailsAgent {
  readonly handle: string;
  readonly name: string;
  readonly projectRef: ScopedProjectRef;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly thread: EnvironmentThreadShell | null;
  readonly threadIsBound?: boolean;
}

export function railsAgentHandle(workspaceRoot: string): string | null {
  return AGENT_HOME_PATTERN.exec(workspaceRoot)?.[1] ?? null;
}

export function railsAgentFaceUrl(handle: string): string {
  return `https://rails.so/api/mobile/v1/agent-faces/${handle}.png`;
}

export function railsAgentThreadKey(thread: EnvironmentThreadShell): string {
  return `${thread.environmentId}:${thread.id}`;
}

function isHomeThreadCandidate(thread: EnvironmentThreadShell): boolean {
  return thread.lineage.parentThreadId === null;
}

function isPreferredHomeThread(
  candidate: EnvironmentThreadShell,
  current: EnvironmentThreadShell,
  boundThreadIds: ReadonlySet<string> | undefined,
) {
  const candidateBound = boundThreadIds?.has(candidate.id) === true;
  if (candidateBound !== (boundThreadIds?.has(current.id) === true)) return candidateBound;
  return candidate.createdAt < current.createdAt;
}

function resolveRailsAgents(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  boundThreadIdByProjectKey: ReadonlyMap<string, string>,
): ReadonlyArray<RailsAgent> {
  const handleByProjectKey = new Map<string, string>();
  const boundThreadIdsByHandle = new Map<string, Set<string>>();
  const agents = new Map<string, { -readonly [K in keyof RailsAgent]: RailsAgent[K] }>();
  for (const project of projects) {
    const handle = railsAgentHandle(project.workspaceRoot);
    if (handle === null) continue;
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    handleByProjectKey.set(scopedProjectKey(projectRef), handle);
    const boundThreadId = boundThreadIdByProjectKey.get(scopedProjectKey(projectRef));
    if (boundThreadId !== undefined) {
      boundThreadIdsByHandle.set(
        handle,
        (boundThreadIdsByHandle.get(handle) ?? new Set()).add(boundThreadId),
      );
    }
    const agent = agents.get(handle);
    if (agent === undefined) {
      agents.set(handle, {
        handle,
        name: project.title,
        projectRef,
        environmentIds: [project.environmentId],
        thread: null,
        threadIsBound: false,
      });
    } else if (!agent.environmentIds.includes(project.environmentId)) {
      agent.environmentIds = [...agent.environmentIds, project.environmentId];
    }
  }
  const agentThreads = filterSidebarV2VisibleThreads(threads, new Set(handleByProjectKey.keys()));
  for (const thread of agentThreads) {
    const handle = handleByProjectKey.get(`${thread.environmentId}:${thread.projectId}`);
    const agent = handle === undefined ? undefined : agents.get(handle);
    if (agent === undefined) continue;
    const boundThreadIds = boundThreadIdsByHandle.get(agent.handle);
    const isBound = boundThreadIds?.has(thread.id) === true;
    if (!isBound && !isHomeThreadCandidate(thread)) continue;
    if (agent.thread === null || isPreferredHomeThread(thread, agent.thread, boundThreadIds)) {
      agent.thread = thread;
      agent.threadIsBound = isBound;
      agent.projectRef = scopeProjectRef(thread.environmentId, thread.projectId);
    }
  }
  return [...agents.values()];
}

export function useRailsAgents(): ReadonlyArray<RailsAgent> {
  const projects = useProjects();
  const homes = projects.filter((project) => railsAgentHandle(project.workspaceRoot) !== null);
  return resolveRailsAgents(projects, useQuietThreadShells(), useAgentHomeBoundThreadIds(homes));
}

export function useWithoutAgentMainThreads<T extends EnvironmentThreadShell>(
  threads: ReadonlyArray<T>,
  scopedProjectKeys: ReadonlySet<string> | null,
): ReadonlyArray<T> {
  const mainThreadKeys = new Set(
    useRailsAgents().flatMap((agent) =>
      agent.thread !== null && agent.threadIsBound === true
        ? [railsAgentThreadKey(agent.thread)]
        : [],
    ),
  );
  if (scopedProjectKeys !== null || mainThreadKeys.size === 0) return threads;
  return threads.filter((thread) => !mainThreadKeys.has(railsAgentThreadKey(thread)));
}
