import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentThreadShell,
  threadRuntimeCanArchive,
} from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { readProject, readThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

function threadSessionRestartBlocker(
  thread: Pick<EnvironmentThreadShell, "runtime" | "pendingBackgroundTasks">,
): string | null {
  if (!threadRuntimeCanArchive(thread.runtime)) {
    return "The agent is working. Restart the session after this turn, or ask the agent to call t3_thread_restart.";
  }
  const tasks = thread.pendingBackgroundTasks.length;
  if (tasks > 0) {
    return `${tasks} background ${tasks === 1 ? "task is" : "tasks are"} still running in this session. Restart after ${tasks === 1 ? "it finishes" : "they finish"}.`;
  }
  return null;
}

export function useRestartThreadSession() {
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  return async (threadRef: ScopedThreadRef) => {
    const thread = readThreadShell(threadRef);
    if (thread === null) return;
    const blocker = threadSessionRestartBlocker(thread);
    if (blocker !== null) {
      toastManager.add({ type: "warning", title: "Session not restarted", description: blocker });
      return;
    }
    if (thread.runtime !== null) {
      const stopped = await stopThreadSession({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
    }
    toastManager.add({
      type: "success",
      title: "Agent session will restart",
      description:
        "The next message starts a fresh session with current MCP servers and settings. History stays.",
    });
    const project = readProject(scopeProjectRef(thread.environmentId, thread.projectId));
    if (project === null) return;
    const refreshed = await refreshProviders({
      environmentId: thread.environmentId,
      input: {
        instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
        cwd: thread.worktreePath ?? project.workspaceRoot,
        fresh: true,
      },
    });
    if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
  };
}
