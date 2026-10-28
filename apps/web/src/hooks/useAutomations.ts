import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useConnectedEnvironmentIds } from "../state/environments";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { serverEnvironment } from "../state/server";

const scheduledTasksAtom = environmentAtomList("sidebar-scheduled-tasks", (environmentId) =>
  serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);

export interface EnvironmentAutomation {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

function useLoadedScheduledTasks(): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly tasks: ReadonlyArray<ScheduledTask>;
}> {
  const connectedIds = useConnectedEnvironmentIds();
  const queries = useAtomValue(scheduledTasksAtom(environmentIdsKey(connectedIds)));
  const loaded: Array<{ environmentId: EnvironmentId; tasks: ReadonlyArray<ScheduledTask> }> = [];
  for (const [index, query] of queries.entries()) {
    const value = Option.getOrNull(AsyncResult.value(query));
    const environmentId = connectedIds[index];
    if (environmentId === undefined || value === null) continue;
    loaded.push({ environmentId, tasks: value.tasks });
  }
  return loaded;
}

export function useAutomations(): ReadonlyArray<EnvironmentAutomation> {
  return useLoadedScheduledTasks().flatMap(({ environmentId, tasks }) =>
    tasks.map((task) => ({ environmentId, task })),
  );
}

const retainedAutomationThreadKeys = new Map<string, ReadonlySet<string>>();

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export function useAutomationThreadKeys(): ReadonlySet<string> {
  for (const { environmentId, tasks } of useLoadedScheduledTasks()) {
    const next = new Set(
      tasks
        .filter((task) => task.threadId !== null)
        .map((task) => `${environmentId}:${task.threadId}`),
    );
    if (!sameKeys(retainedAutomationThreadKeys.get(environmentId) ?? new Set(), next)) {
      retainedAutomationThreadKeys.set(environmentId, next);
    }
  }

  const keys = new Set<string>();
  for (const environmentKeys of retainedAutomationThreadKeys.values()) {
    for (const key of environmentKeys) keys.add(key);
  }
  return keys;
}
