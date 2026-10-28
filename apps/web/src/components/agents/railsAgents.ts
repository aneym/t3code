import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { threadFamilies } from "../../state/threads";
import { type EnvironmentAgentHome, useAgentHomes } from "./agentHomeBindings";

const AGENT_HOME_PATTERN = /\/\.agent-rails\/agents\/([a-z0-9][a-z0-9-]*)\/?$/;

export interface RailsAgent {
  readonly handle: string;
  readonly name: string;
  readonly projectRef: ScopedProjectRef | null;
  readonly homeProjectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly target: ScopedThreadRef | null;
  readonly thread: EnvironmentThreadShell | null;
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

function bindingTime(home: EnvironmentAgentHome): number {
  const time = Date.parse(home.binding?.at ?? "");
  return Number.isFinite(time) ? time : 0;
}

export function useRailsAgents(): ReadonlyArray<RailsAgent> {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const homes = useAgentHomes();
  const environments = useEnvironmentIdentities();
  const groups = new Map<string, EnvironmentAgentHome[]>();
  for (const home of homes) {
    const group = groups.get(home.handle) ?? [];
    group.push(home);
    groups.set(home.handle, group);
  }
  const agents: RailsAgent[] = [];
  for (const [handle, group] of groups) {
    if (!group.some((home) => home.role === "orch")) continue;
    const ordered = group.toSorted((a, b) => a.environmentId.localeCompare(b.environmentId));
    const winner = ordered
      .filter((home) => home.binding !== null)
      .toSorted((a, b) => bindingTime(b) - bindingTime(a))[0];
    const binding = winner?.binding;
    const target =
      binding && winner
        ? {
            environmentId:
              environments.find((env) => env.environmentId === binding.environmentId)
                ?.environmentId ??
              environments.find((env) => env.label.toLowerCase() === binding.host?.toLowerCase())
                ?.environmentId ??
              winner.environmentId,
            threadId: binding.threadId,
          }
        : null;
    const homeProjectRefs = ordered.flatMap((home) => {
      const project = projects.find(
        (entry) =>
          entry.environmentId === home.environmentId &&
          entry.workspaceRoot.replace(/\/$/, "") === home.workspaceRoot.replace(/\/$/, ""),
      );
      return project ? [scopeProjectRef(project.environmentId, project.id)] : [];
    });
    const preferred = winner ?? ordered[0];
    const projectRef =
      homeProjectRefs.find((ref) => ref.environmentId === preferred?.environmentId) ??
      homeProjectRefs[0] ??
      null;
    const project = projects.find(
      (entry) =>
        entry.environmentId === projectRef?.environmentId && entry.id === projectRef.projectId,
    );
    agents.push({
      handle,
      name:
        preferred?.displayName ??
        ordered.find((home) => home.displayName)?.displayName ??
        project?.title ??
        handle,
      projectRef,
      homeProjectRefs,
      environmentIds: ordered.map((home) => home.environmentId),
      target,
      thread: target
        ? (threads.find(
            (thread) =>
              thread.environmentId === target.environmentId && thread.id === target.threadId,
          ) ?? null)
        : null,
    });
  }
  const targetKey = JSON.stringify(agents.flatMap((agent) => (agent.target ? [agent.target] : [])));
  // oxlint-disable-next-line t3code/react-effect-budget -- bound threads outside the shell window need a live detail subscription
  useEffect(() => {
    const targets = JSON.parse(targetKey) as ScopedThreadRef[];
    const releases = targets.map((target) =>
      threadFamilies.mount(appAtomRegistry, target.environmentId, target.threadId),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [targetKey]);
  return agents;
}

export function useWithoutAgentMainThreads<T extends EnvironmentThreadShell>(
  threads: ReadonlyArray<T>,
  _scopedProjectKeys: ReadonlySet<string> | null,
): ReadonlyArray<T> {
  const mainThreadKeys = new Set(
    useRailsAgents().flatMap((agent) =>
      agent.target ? [`${agent.target.environmentId}:${agent.target.threadId}`] : [],
    ),
  );
  return threads.filter((thread) => !mainThreadKeys.has(railsAgentThreadKey(thread)));
}
