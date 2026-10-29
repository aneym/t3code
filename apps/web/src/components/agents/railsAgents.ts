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
  readonly remoteHost: string | null;
  readonly projects: ReadonlyArray<string>;
  readonly lanes: ReadonlyArray<ScopedThreadRef>;
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

function environmentForHost(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
  host: string | null,
): EnvironmentId | undefined {
  if (host === null) return undefined;
  const wanted = host.toLowerCase();
  const exact = environments.find((env) => env.label.toLowerCase() === wanted);
  if (exact) return exact.environmentId;
  const named = environments.filter((env) =>
    env.label
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .includes(wanted),
  );
  return named.length === 1 ? named[0]?.environmentId : undefined;
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
    const targetEnvironmentId = binding
      ? (environments.find((env) => env.environmentId === binding.environmentId)?.environmentId ??
        environmentForHost(environments, binding.host) ??
        (binding.environmentId === null && binding.host === null ? winner?.environmentId : null))
      : null;
    const target =
      binding && targetEnvironmentId
        ? { environmentId: targetEnvironmentId, threadId: binding.threadId }
        : null;
    const remoteHost = binding && !target ? (binding.host ?? "another host") : null;
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
    agents.push({
      handle,
      name:
        preferred?.displayName ??
        ordered.find((home) => home.displayName)?.displayName ??
        handle.replace(
          /(^|-)([a-z])/g,
          (_, dash: string, letter: string) => `${dash ? " " : ""}${letter.toUpperCase()}`,
        ),
      projectRef,
      homeProjectRefs,
      environmentIds: ordered.map((home) => home.environmentId),
      target,
      remoteHost,
      projects: [...new Set(ordered.flatMap((home) => home.projects))],
      lanes: ordered.flatMap((home) =>
        home.lanes.flatMap((lane) => {
          const environmentId =
            lane.host === null ? home.environmentId : environmentForHost(environments, lane.host);
          return environmentId ? [{ environmentId, threadId: lane.threadId }] : [];
        }),
      ),
      thread: target
        ? (threads.find(
            (thread) =>
              thread.environmentId === target.environmentId && thread.id === target.threadId,
          ) ?? null)
        : null,
    });
  }
  const targetKey = JSON.stringify(agents.flatMap((agent) => (agent.target ? [agent.target] : [])));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds live detail subscriptions for bound threads outside the shell window until unmount
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
