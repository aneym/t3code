import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";

import { useProjects, useQuietThreadShells } from "../../state/entities";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

const AGENT_HOME_PATTERN = /\/\.agent-rails\/agents\/([a-z0-9][a-z0-9-]*)\/?$/;

export const DEFAULT_PINNED_AGENT_HANDLES: ReadonlyArray<string> = ["content", "raise", "sunday"];

export interface RailsAgent {
  readonly handle: string;
  readonly name: string;
  readonly projectRef: ScopedProjectRef;
  readonly thread: EnvironmentThreadShell | null;
}

function railsAgentHandle(workspaceRoot: string): string | null {
  return AGENT_HOME_PATTERN.exec(workspaceRoot)?.[1] ?? null;
}

export function railsAgentFaceUrl(handle: string): string {
  return `https://rails.so/api/mobile/v1/agent-faces/${handle}.png`;
}

export function railsAgentThreadKey(thread: EnvironmentThreadShell): string {
  return `${thread.environmentId}:${thread.id}`;
}

function threadActivityAt(thread: EnvironmentThreadShell): string {
  return thread.latestRun?.requestedAt ?? thread.updatedAt ?? thread.createdAt;
}

function isPreferredThread(candidate: EnvironmentThreadShell, current: EnvironmentThreadShell) {
  if ((candidate.pinnedAt === null) !== (current.pinnedAt === null)) {
    return candidate.pinnedAt !== null;
  }
  return threadActivityAt(candidate) > threadActivityAt(current);
}

function resolveRailsAgents(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<RailsAgent> {
  const handleByProjectKey = new Map<string, string>();
  const agents = new Map<string, { -readonly [K in keyof RailsAgent]: RailsAgent[K] }>();
  for (const project of projects) {
    const handle = railsAgentHandle(project.workspaceRoot);
    if (handle === null) continue;
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    handleByProjectKey.set(scopedProjectKey(projectRef), handle);
    if (!agents.has(handle)) {
      agents.set(handle, { handle, name: project.title, projectRef, thread: null });
    }
  }
  const agentThreads = filterSidebarV2VisibleThreads(threads, new Set(handleByProjectKey.keys()));
  for (const thread of agentThreads) {
    const handle = handleByProjectKey.get(`${thread.environmentId}:${thread.projectId}`);
    const agent = handle === undefined ? undefined : agents.get(handle);
    if (agent === undefined) continue;
    if (agent.thread === null || isPreferredThread(thread, agent.thread)) {
      agent.thread = thread;
      agent.projectRef = scopeProjectRef(thread.environmentId, thread.projectId);
    }
  }
  return [...agents.values()];
}

export function useRailsAgents(): ReadonlyArray<RailsAgent> {
  return resolveRailsAgents(useProjects(), useQuietThreadShells());
}

export function useWithoutAgentThreads<T extends EnvironmentThreadShell>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const agentThreadKeys = new Set(
    useRailsAgents().flatMap((agent) =>
      agent.thread === null ? [] : [railsAgentThreadKey(agent.thread)],
    ),
  );
  if (agentThreadKeys.size === 0) return threads;
  return threads.filter((thread) => !agentThreadKeys.has(railsAgentThreadKey(thread)));
}
