import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projects";
import { threadFamilies } from "../../state/threads";

export const AGENT_HOME_FILE = "agent.json";
const RETRY_AFTER_MS = 30_000;

export interface AgentHomeIdentity {
  readonly threadId: string | null;
  readonly role: string | null;
  readonly displayName: string | null;
}

interface AgentHomeBindingState {
  readonly identityByHome: Readonly<Record<string, AgentHomeIdentity>>;
  readonly settle: (homeKey: string, identity: AgentHomeIdentity) => void;
}

const NO_IDENTITY: AgentHomeIdentity = { threadId: null, role: null, displayName: null };

const useAgentHomeBindingStore = create<AgentHomeBindingState>((set) => ({
  identityByHome: {},
  settle: (homeKey, identity) =>
    set((state) => ({ identityByHome: { ...state.identityByHome, [homeKey]: identity } })),
}));

const inFlight = new Set<string>();

function homeKey(project: EnvironmentProject): string {
  return `${project.environmentId}:${project.workspaceRoot}`;
}

function parseAgentHomeIdentity(contents: string): AgentHomeIdentity {
  try {
    const home = JSON.parse(contents) as {
      t3?: { thread_id?: unknown };
      role?: unknown;
      display_name?: unknown;
    };
    const threadId = home.t3?.thread_id;
    return {
      threadId: typeof threadId === "string" && threadId.length > 0 ? threadId : null,
      role: typeof home.role === "string" ? home.role : null,
      displayName:
        typeof home.display_name === "string" && home.display_name.length > 0
          ? home.display_name
          : null,
    };
  } catch {
    return NO_IDENTITY;
  }
}

async function loadBinding(project: EnvironmentProject): Promise<void> {
  const key = homeKey(project);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.readFile({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot, relativePath: AGENT_HOME_FILE, allowMissing: true },
    }),
    { label: "Read agent home binding", reportFailure: false, refresh: true },
  );
  if (result._tag === "Failure") {
    setTimeout(() => {
      inFlight.delete(key);
      void loadBinding(project);
    }, RETRY_AFTER_MS);
    return;
  }
  inFlight.delete(key);
  settleAgentHomeIdentity(
    project,
    result.value.exists === false ? NO_IDENTITY : parseAgentHomeIdentity(result.value.contents),
  );
}

function settleAgentHomeIdentity(project: EnvironmentProject, identity: AgentHomeIdentity) {
  if (identity.threadId !== null) {
    threadFamilies.mount(appAtomRegistry, project.environmentId, ThreadId.make(identity.threadId));
  }
  useAgentHomeBindingStore.getState().settle(homeKey(project), identity);
}

export function settleAgentHomeBinding(project: EnvironmentProject, threadId: string) {
  const current = useAgentHomeBindingStore.getState().identityByHome[homeKey(project)];
  settleAgentHomeIdentity(project, { ...(current ?? NO_IDENTITY), threadId });
}

export function useAgentHomeIdentities(
  homes: ReadonlyArray<EnvironmentProject>,
): ReadonlyMap<string, AgentHomeIdentity> {
  const identityByHome = useAgentHomeBindingStore((state) => state.identityByHome);
  // oxlint-disable-next-line t3code/react-effect-budget -- agent.json lives on each host and is read over RPC once per home
  useEffect(() => {
    for (const project of homes) {
      if (!(homeKey(project) in useAgentHomeBindingStore.getState().identityByHome)) {
        void loadBinding(project);
      }
    }
  }, [homes]);
  const identities = new Map<string, AgentHomeIdentity>();
  for (const project of homes) {
    const identity = identityByHome[homeKey(project)];
    if (identity !== undefined) identities.set(`${project.environmentId}:${project.id}`, identity);
  }
  return identities;
}
