import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";

import { resolveWorkingStartedAt } from "../Sidebar.logic";

export type AutomationStatus =
  | { readonly kind: "working"; readonly startedAt: string | null }
  | { readonly kind: "failed"; readonly error: string | null }
  | { readonly kind: "idle" };

function runRequestedAt(thread: EnvironmentThreadShell): string {
  return thread.latestRun?.requestedAt ?? thread.createdAt;
}

export function resolveAutomationRunThread(
  environmentId: EnvironmentId,
  task: ScheduledTask,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell | null {
  let latest: EnvironmentThreadShell | null = null;
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    if (thread.id !== task.threadId && thread.automationTaskId !== task.id) continue;
    if (threadRuntimeIsActive(thread.runtime)) return thread;
    if (latest === null || runRequestedAt(thread) > runRequestedAt(latest)) latest = thread;
  }
  return latest;
}

// The scheduler records success once the prompt is dispatched, so the run
// thread's runtime is the only signal that the job is still working.
export function resolveAutomationStatus(
  task: ScheduledTask,
  runThread: EnvironmentThreadShell | null,
): AutomationStatus {
  if (runThread !== null && threadRuntimeIsActive(runThread.runtime)) {
    return { kind: "working", startedAt: resolveWorkingStartedAt(runThread) };
  }
  if (task.lastRunStatus === "running") return { kind: "working", startedAt: task.lastRunAt };
  if (task.lastRunStatus === "failed") return { kind: "failed", error: task.lastRunError };
  if (runThread?.runtime?.status === "failed") {
    return { kind: "failed", error: runThread.runtime.lastError };
  }
  return { kind: "idle" };
}
