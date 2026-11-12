import { persistEnvironmentThreadSnapshots } from "@t3tools/client-runtime/state/threads";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { AppState } from "react-native";

import { runtime } from "../lib/runtime";
import { MobileDatabase } from "../persistence/mobile-database";
import { appAtomRegistry } from "./atom-registry";
import { environmentShell } from "./shell";
import { getOpenThreadCacheKey } from "./thread-cache-protection";
import { threadOutboxManager } from "./thread-outbox";
import { environmentThreads, environmentThreadShells } from "./threads";
import { workspaceConnections } from "./workspace";

const PREFETCH_CONCURRENCY = 2;
const PREFETCH_WAIT_MS = 30_000;
const PREFETCH_DEBOUNCE_MS = 250;

const prefetchInputsAtom = Atom.make((get) => {
  const environments = get(workspaceConnections.environmentsAtom);
  return {
    environments,
    threads: get(environmentThreadShells.quietThreadShellsAtom),
    loaded: get(threadOutboxManager.loadedAtom),
    queued: get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    live: new Set(
      environments
        .filter(
          ({ environmentId, connectionState }) =>
            connectionState === "connected" &&
            get(environmentShell.stateValueAtom(environmentId)).status === "live",
        )
        .map(({ environmentId }) => environmentId),
    ),
  };
}).pipe(Atom.withLabel("mobile:thread-prefetch:inputs"));

type PrefetchTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly updatedAt: string;
  readonly running: boolean;
};

function waitForThread(target: PrefetchTarget, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const atom = environmentThreads.stateAtom(target.environmentId, target.threadId);
  const release = appAtomRegistry.mount(atom);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const timeout = setTimeout(finish, PREFETCH_WAIT_MS);
    const aborted = () => finish(false);
    function finish(synchronized = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      release();
      signal.removeEventListener("abort", aborted);
      resolve(synchronized);
    }
    const check = () => {
      const result = appAtomRegistry.get(atom);
      const value = AsyncResult.value(result);
      if (AsyncResult.isFailure(result)) {
        finish();
      } else if (
        value._tag === "Some" &&
        (value.value.status === "live" || value.value.status === "deleted")
      ) {
        finish(true);
      }
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) finish();
    else check();
  });
}

export function installThreadOfflineSync(): () => void {
  let active = true;
  let foreground = AppState.currentState === "active";
  let running = false;
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  const refreshed = new Map<string, string>();

  const eligible = (target: PrefetchTarget): boolean => {
    const current = appAtomRegistry.get(prefetchInputsAtom);
    return (
      active &&
      foreground &&
      current.loaded &&
      current.live.has(target.environmentId) &&
      !Object.values(current.queued)
        .flat()
        .some((message) => message.environmentId === target.environmentId) &&
      getOpenThreadCacheKey() !== `${target.environmentId}:${target.threadId}`
    );
  };

  const run = async () => {
    timer = undefined;
    if (!active || !foreground || running) return;
    requested = false;
    const current = appAtomRegistry.get(prefetchInputsAtom);
    if (!current.loaded) return;
    const candidates = current.threads
      .filter(
        (thread) =>
          current.live.has(thread.environmentId) &&
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.lineage.parentThreadId === null,
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const eligibleCandidates = candidates.filter(
      (thread) =>
        !Object.values(current.queued)
          .flat()
          .some((message) => message.environmentId === thread.environmentId) &&
        getOpenThreadCacheKey() !== `${thread.environmentId}:${thread.id}`,
    );
    const recent = eligibleCandidates
      .filter((thread) => !threadRuntimeIsActive(thread.runtime))
      .slice(0, 50);
    const runningThreads = eligibleCandidates
      .filter((thread) => threadRuntimeIsActive(thread.runtime))
      .slice(0, 10);
    const targets = [
      ...new Map(
        [...runningThreads, ...recent].map((thread) => [
          `${thread.environmentId}:${thread.id}`,
          {
            environmentId: thread.environmentId,
            threadId: thread.id,
            updatedAt: thread.updatedAt,
            running: threadRuntimeIsActive(thread.runtime),
          },
        ]),
      ).values(),
    ].filter(eligible);
    running = true;
    const controller = new AbortController();
    abort = controller;
    try {
      const indexes = await runtime.runPromise(
        MobileDatabase.pipe(
          Effect.flatMap((database) =>
            Effect.forEach(
              [...new Set(targets.map((target) => target.environmentId))],
              (environmentId) => database.listThreadCacheIndex(environmentId),
              { concurrency: "unbounded" },
            ),
          ),
        ),
      );
      const environmentIds = [...new Set(targets.map((target) => target.environmentId))];
      const cached = new Map(
        indexes.flatMap((rows, index) =>
          rows.map((row) => [`${environmentIds[index]}:${row.threadId}`, row.sourceUpdatedAt]),
        ),
      );
      const pending = targets.filter((target) => {
        const key = `${target.environmentId}:${target.threadId}`;
        if (refreshed.get(key) === target.updatedAt) return false;
        const cachedAt = cached.get(key);
        return target.running || cachedAt == null || cachedAt < Date.parse(target.updatedAt);
      });
      let next = 0;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const target = pending[next++];
          if (!target) return;
          if (!eligible(target)) continue;
          const synchronized = await waitForThread(target, controller.signal);
          if (synchronized && !controller.signal.aborted)
            refreshed.set(`${target.environmentId}:${target.threadId}`, target.updatedAt);
        }
      };
      await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
    } catch (error) {
      console.warn("[thread-prefetch] could not refresh cached threads", error);
    } finally {
      running = false;
      abort = undefined;
      if (requested) schedule();
    }
  };

  function schedule() {
    if (!active || !foreground) return;
    requested = true;
    if (running) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(), PREFETCH_DEBOUNCE_MS);
  }

  let liveEnvironments = new Set<EnvironmentId>();
  const stop = appAtomRegistry.subscribe(
    prefetchInputsAtom,
    (inputs) => {
      const reconnected = [...inputs.live].some((id) => !liveEnvironments.has(id));
      if (reconnected) refreshed.clear();
      liveEnvironments = inputs.live;
      if (
        abort &&
        (!inputs.loaded ||
          Object.values(inputs.queued).some((queue) => queue.length > 0) ||
          inputs.live.size === 0)
      )
        abort.abort();
      schedule();
    },
    { immediate: true },
  );
  const subscription = AppState.addEventListener("change", (state) => {
    const wasForeground = foreground;
    foreground = state === "active";
    if (!foreground) {
      abort?.abort();
      clearTimeout(timer);
      void runtime.runPromise(
        persistEnvironmentThreadSnapshots.pipe(Effect.catch(() => Effect.void)),
      );
    } else if (!wasForeground) {
      refreshed.clear();
      schedule();
    }
  });
  return () => {
    active = false;
    stop();
    subscription.remove();
    abort?.abort();
    clearTimeout(timer);
  };
}
