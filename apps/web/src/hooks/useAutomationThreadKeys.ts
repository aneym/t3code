import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useConnectedEnvironmentIds } from "../state/environments";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { serverEnvironment } from "../state/server";

const scheduledTasksAtom = environmentAtomList("sidebar-scheduled-tasks", (environmentId) =>
  serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);

export function useAutomationThreadKeys(): ReadonlySet<string> {
  const connectedIds = useConnectedEnvironmentIds();
  const queries = useAtomValue(scheduledTasksAtom(environmentIdsKey(connectedIds)));
  const keys = new Set<string>();
  for (const [index, query] of queries.entries()) {
    for (const task of Option.getOrNull(AsyncResult.value(query))?.tasks ?? []) {
      if (task.threadId !== null) keys.add(`${connectedIds[index]}:${task.threadId}`);
    }
  }
  return keys;
}
