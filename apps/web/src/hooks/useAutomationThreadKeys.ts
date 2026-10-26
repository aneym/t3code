import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useConnectedEnvironmentIds } from "../state/environments";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { serverEnvironment } from "../state/server";

const scheduledTasksAtom = environmentAtomList("sidebar-scheduled-tasks", (environmentId) =>
  serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);

const retainedAutomationThreadKeys = new Map<string, ReadonlySet<string>>();

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export function useAutomationThreadKeys(): ReadonlySet<string> {
  const connectedIds = useConnectedEnvironmentIds();
  const queries = useAtomValue(scheduledTasksAtom(environmentIdsKey(connectedIds)));
  for (const [index, query] of queries.entries()) {
    const value = Option.getOrNull(AsyncResult.value(query));
    const environmentId = connectedIds[index];
    if (environmentId === undefined || value === null) continue;
    const next = new Set(
      value.tasks
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
