import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { AsyncResult } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { THREAD_PREFETCH_LIMIT } from "../persistence/thread-cache-budget";
import { MobileDatabase } from "../persistence/mobile-database";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentShell } from "./shell";
import { environmentThreads } from "./threads";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";
import { useQuietThreadShells } from "./entities";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { getOpenThreadCacheKey } from "./thread-outbox";

type PrefetchTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly updatedAt: string;
};

const PREFETCH_CONCURRENCY = 2;
const PREFETCH_WAIT_MS = 30_000;
const PREFETCH_DEBOUNCE_MS = 250;

function sourceUpdatedAt(updatedAt: string): number | null {
  const value = Date.parse(updatedAt);
  return Number.isFinite(value) ? value : null;
}

function readThreadStatus(environmentId: EnvironmentId, threadId: ThreadId) {
  const value = AsyncResult.value(
    appAtomRegistry.get(environmentThreads.stateAtom(environmentId, threadId)),
  );
  return value._tag === "Some" ? value.value.status : "empty";
}

function waitForThread(environmentId: EnvironmentId, threadId: ThreadId, signal: AbortSignal) {
  const atom = environmentThreads.stateAtom(environmentId, threadId);
  const release = appAtomRegistry.mount(atom);
  return new Promise<void>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const timeout = setTimeout(finish, PREFETCH_WAIT_MS);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      release();
      signal.removeEventListener("abort", finish);
      resolve();
    }
    unsubscribe = appAtomRegistry.subscribe(atom, () => {
      const status = readThreadStatus(environmentId, threadId);
      if (status === "live" || status === "deleted") finish();
    });
    signal.addEventListener("abort", finish, { once: true });
    const status = readThreadStatus(environmentId, threadId);
    if (status === "live" || status === "deleted") finish();
  });
}

async function runPrefetch(targets: ReadonlyArray<PrefetchTarget>, signal: AbortSignal) {
  let next = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const target = targets[next++];
      if (target === undefined) return;
      await waitForThread(target.environmentId, target.threadId, signal);
    }
  };
  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
}

export function useThreadPrefetch(): void {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const threadShells = useQuietThreadShells();
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dataRef = useRef({
    connectedEnvironments,
    threadShells,
    queuedMessagesByThreadKey,
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- lifecycle data ref synchronization
  useEffect(() => {
    dataRef.current = {
      connectedEnvironments,
      threadShells,
      queuedMessagesByThreadKey,
    };
  }, [connectedEnvironments, threadShells, queuedMessagesByThreadKey]);
  const passRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const foregroundRef = useRef(AppState.currentState === "active");
  const connectedRef = useRef(new Set<EnvironmentId>());

  // oxlint-disable-next-line t3code/react-effect-budget -- lifecycle subscription starts and stops prefetch work
  useEffect(() => {
    const run = () => {
      timerRef.current = null;
      if (!foregroundRef.current || runningRef.current) return;
      const current = dataRef.current;
      const connected = new Set(
        current.connectedEnvironments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => environment.environmentId),
      );
      const queuedEnvironments = new Set(
        Object.values(current.queuedMessagesByThreadKey)
          .flat()
          .map((message) => message.environmentId),
      );
      const candidates = current.threadShells.filter((thread) => {
        if (!connected.has(thread.environmentId) || queuedEnvironments.has(thread.environmentId))
          return false;
        if (getOpenThreadCacheKey() === `${thread.environmentId}:${thread.id}`) return false;
        if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
        if (thread.lineage.parentThreadId !== null) return false;
        return (
          appAtomRegistry.get(environmentShell.stateValueAtom(thread.environmentId)).status ===
          "live"
        );
      });
      const active = candidates
        .filter((thread) => threadRuntimeIsActive(thread.runtime))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 10);
      const recent = candidates
        .filter((thread) => !threadRuntimeIsActive(thread.runtime))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, THREAD_PREFETCH_LIMIT);
      const targets = [...active, ...recent].map((thread) => ({
        environmentId: thread.environmentId,
        threadId: thread.id,
        updatedAt: thread.updatedAt,
      }));
      runningRef.current = true;
      const abort = new AbortController();
      abortRef.current = abort;
      void runtime.runPromise(
        Effect.gen(function* () {
          const database = yield* MobileDatabase;
          const indexes = new Map<
            EnvironmentId,
            ReadonlyArray<{ threadId: string; sourceUpdatedAt: number | null }>
          >();
          for (const environmentId of connected) {
            const rows = yield* database.listThreadCacheIndex(environmentId);
            indexes.set(environmentId, rows);
          }
          return targets.filter((target) => {
            const cached = indexes
              .get(target.environmentId)
              ?.find((row) => row.threadId === target.threadId);
            if (
              threadRuntimeIsActive(
                current.threadShells.find(
                  (thread) =>
                    thread.environmentId === target.environmentId && thread.id === target.threadId,
                )?.runtime,
              )
            )
              return true;
            const cachedAt = cached?.sourceUpdatedAt;
            const shellAt = sourceUpdatedAt(target.updatedAt);
            return (
              cachedAt === null || cachedAt === undefined || shellAt === null || cachedAt < shellAt
            );
          });
        }).pipe(
          Effect.catch(() => Effect.succeed([])),
          Effect.flatMap((pending) => Effect.promise(() => runPrefetch(pending, abort.signal))),
          Effect.ensuring(
            Effect.sync(() => {
              runningRef.current = false;
              abortRef.current = null;
            }),
          ),
        ),
      );
    };
    passRef.current = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(run, PREFETCH_DEBOUNCE_MS);
    };
    const appState = AppState.addEventListener("change", (state) => {
      const wasForeground = foregroundRef.current;
      foregroundRef.current = state === "active";
      if (foregroundRef.current && !wasForeground) passRef.current?.();
    });
    return () => {
      appState.remove();
      abortRef.current?.abort();
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      passRef.current = null;
    };
  }, []);

  // oxlint-disable-next-line t3code/react-effect-budget -- reconnect starts a debounced prefetch pass
  useEffect(() => {
    const connected = new Set(
      connectedEnvironments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    );
    const changed = [...connected].some((id) => !connectedRef.current.has(id));
    connectedRef.current = connected;
    if (changed) passRef.current?.();
  }, [connectedEnvironments]);
}
