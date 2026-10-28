import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProjects } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { toastManager } from "../ui/toast";
import { AGENT_HOME_FILE, settleAgentHomeBinding } from "./agentHomeBindings";
import { railsAgentHandle, useRailsAgents } from "./railsAgents";

export interface AgentMainThreadOption {
  readonly handle: string;
  readonly name: string;
  readonly isCurrent: boolean;
}

type AgentHomeBinding = { thread_id: string; host?: string; at?: string; by?: string };

async function bindHome(
  home: EnvironmentProject,
  thread: EnvironmentThreadShell,
  host: string,
): Promise<void> {
  const read = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.readFile({
      environmentId: home.environmentId,
      input: { cwd: home.workspaceRoot, relativePath: AGENT_HOME_FILE, allowMissing: true },
    }),
    { label: "Read agent home binding", refresh: true },
  );
  if (read._tag === "Failure") throw squashAtomCommandFailure(read);
  if (read.value.exists === false) return;
  const document = JSON.parse(read.value.contents) as { t3?: AgentHomeBinding };
  const previous = document.t3;
  document.t3 = {
    thread_id: thread.id,
    host,
    at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    by: "t3-menu",
    ...(previous?.thread_id !== undefined && previous.thread_id !== thread.id
      ? {
          previous: {
            thread_id: previous.thread_id,
            host: previous.host,
            at: previous.at,
            by: previous.by,
          },
        }
      : {}),
  };
  const written = await runAtomCommand(appAtomRegistry, projectEnvironment.writeFile, {
    environmentId: home.environmentId,
    input: {
      cwd: home.workspaceRoot,
      relativePath: AGENT_HOME_FILE,
      contents: `${JSON.stringify(document, null, 2)}\n`,
    },
  });
  if (written._tag === "Failure") throw squashAtomCommandFailure(written);
  settleAgentHomeBinding(home, thread.id);
}

export function useAgentMainThreadMenu() {
  const agents = useRailsAgents();
  const projects = useProjects();
  const environments = useEnvironmentIdentities();
  const homesOf = (handle: string) =>
    projects.filter((project) => railsAgentHandle(project.workspaceRoot) === handle);
  return {
    options(thread: EnvironmentThreadShell): ReadonlyArray<AgentMainThreadOption> {
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      );
      const homeHandle = project === undefined ? null : railsAgentHandle(project.workspaceRoot);
      return agents
        .filter((agent) => homeHandle === null || agent.handle === homeHandle)
        .map((agent) => ({
          handle: agent.handle,
          name: agent.name,
          isCurrent: agent.threadIsBound === true && agent.thread?.id === thread.id,
        }))
        .toSorted((left, right) => left.name.localeCompare(right.name));
    },
    async assign(handle: string, thread: EnvironmentThreadShell): Promise<void> {
      const host =
        environments
          .find((environment) => environment.environmentId === thread.environmentId)
          ?.label.toLowerCase() ?? thread.environmentId;
      const name = agents.find((agent) => agent.handle === handle)?.name ?? handle;
      try {
        await Promise.all(homesOf(handle).map((home) => bindHome(home, thread, host)));
        toastManager.add({
          type: "success",
          title: `${thread.title} is now ${name}'s main thread`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not make this ${name}'s main thread`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
  };
}
