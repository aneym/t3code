import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projects";
import { threadFamilies } from "../../state/threads";

const AGENT_HOME_FILE = "agent.json";
const RETRY_AFTER_MS = 30_000;

interface AgentHomeBindingState {
  readonly threadIdByHome: Readonly<Record<string, string | null>>;
  readonly settle: (homeKey: string, threadId: string | null) => void;
}

const useAgentHomeBindingStore = create<AgentHomeBindingState>((set) => ({
  threadIdByHome: {},
  settle: (homeKey, threadId) =>
    set((state) => ({ threadIdByHome: { ...state.threadIdByHome, [homeKey]: threadId } })),
}));

const inFlight = new Set<string>();

function homeKey(project: EnvironmentProject): string {
  return `${project.environmentId}:${project.workspaceRoot}`;
}

function parseAgentHomeThreadId(contents: string): string | null {
  try {
    const threadId = (JSON.parse(contents) as { t3?: { thread_id?: unknown } }).t3?.thread_id;
    return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
  } catch {
    return null;
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
  const threadId =
    result.value.exists === false ? null : parseAgentHomeThreadId(result.value.contents);
  if (threadId !== null) {
    threadFamilies.mount(appAtomRegistry, project.environmentId, ThreadId.make(threadId));
  }
  useAgentHomeBindingStore.getState().settle(key, threadId);
}

export function useAgentHomeBoundThreadIds(
  homes: ReadonlyArray<EnvironmentProject>,
): ReadonlyMap<string, string> {
  const threadIdByHome = useAgentHomeBindingStore((state) => state.threadIdByHome);
  // oxlint-disable-next-line t3code/react-effect-budget -- agent.json lives on each host and is read over RPC once per home
  useEffect(() => {
    for (const project of homes) {
      if (!(homeKey(project) in useAgentHomeBindingStore.getState().threadIdByHome)) {
        void loadBinding(project);
      }
    }
  }, [homes]);
  const bound = new Map<string, string>();
  for (const project of homes) {
    const threadId = threadIdByHome[homeKey(project)];
    if (threadId != null) bound.set(`${project.environmentId}:${project.id}`, threadId);
  }
  return bound;
}
