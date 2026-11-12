import type { ApplicationStoredEvent, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const DEFAULT_ENTRY_TTL_MS = 5_000;
const MAX_THREADS = 512;
const MAX_KEYS_PER_THREAD = 32;
const UNCACHED_RECORD_FIELDS: ReadonlySet<string> = new Set(["messages", "turnItems"]);

interface Entry {
  readonly expiresAt: number;
  readonly result: Deferred.Deferred<unknown, unknown>;
}

interface ThreadEntries {
  readonly version: number;
  readonly keys: Map<string, Entry>;
}

interface ThreadReadCacheShape {
  readonly read: <A, E>(
    threadId: ThreadId,
    key: string,
    load: Effect.Effect<A, E>,
    keep: (value: A) => boolean,
  ) => Effect.Effect<A, E>;
  readonly invalidate: (threadIds: Iterable<ThreadId>) => Effect.Effect<void>;
}

export class ThreadReadCache extends Context.Service<ThreadReadCache, ThreadReadCacheShape>()(
  "t3/orchestration-v2/ThreadReadCache",
) {}

const entriesFor = (
  threads: Map<ThreadId, ThreadEntries>,
  threadId: ThreadId,
  version: number,
): ThreadEntries => {
  const current = threads.get(threadId);
  if (current !== undefined && current.version === version) return current;
  const next = { version, keys: new Map<string, Entry>() };
  threads.delete(threadId);
  threads.set(threadId, next);
  if (threads.size > MAX_THREADS) {
    const oldest = threads.keys().next().value;
    if (oldest !== undefined) threads.delete(oldest);
  }
  return next;
};

export const layer: Layer.Layer<ThreadReadCache> = Layer.effect(
  ThreadReadCache,
  Effect.gen(function* () {
    const ttlMs = yield* Config.Int("T3CODE_THREAD_READ_CACHE_TTL_MS").pipe(
      Effect.orElseSucceed(() => DEFAULT_ENTRY_TTL_MS),
    );
    const versions = new Map<ThreadId, number>();
    const threads = new Map<ThreadId, ThreadEntries>();
    const read = Effect.fn("ThreadReadCache.read")(function* <A, E>(
      threadId: ThreadId,
      key: string,
      load: Effect.Effect<A, E>,
      keep: (value: A) => boolean,
    ) {
      if (ttlMs <= 0) return yield* load;
      const now = yield* Clock.currentTimeMillis;
      const owner = entriesFor(threads, threadId, versions.get(threadId) ?? 0);
      const hit = owner.keys.get(key);
      if (hit !== undefined && hit.expiresAt > now) {
        return yield* Deferred.await(hit.result as Deferred.Deferred<A, E>);
      }
      if (owner.keys.size >= MAX_KEYS_PER_THREAD) owner.keys.clear();
      const result = yield* Deferred.make<A, E>();
      const entry: Entry = {
        expiresAt: now + ttlMs,
        result: result as Deferred.Deferred<unknown, unknown>,
      };
      owner.keys.set(key, entry);
      yield* load.pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit) && keep(exit.value)) return;
            if (owner.keys.get(key) === entry) owner.keys.delete(key);
          }),
        ),
        Effect.flatMap((exit) => Deferred.done(result, exit)),
        Effect.forkDetach,
      );
      return yield* Deferred.await(result);
    });
    const invalidate = (threadIds: Iterable<ThreadId>) =>
      Effect.sync(() => {
        for (const threadId of threadIds) {
          versions.set(threadId, (versions.get(threadId) ?? 0) + 1);
          threads.delete(threadId);
        }
      });
    return { read, invalidate };
  }),
);

const committedThreadIds = (events: ReadonlyArray<ApplicationStoredEvent>) =>
  new Set(events.flatMap((stored) => ("event" in stored ? [stored.event.threadId] : [])));

export const layerEventStore: Layer.Layer<
  EventStore.EventStoreV2,
  never,
  EventStore.EventStoreV2 | ThreadReadCache
> = Layer.effect(
  EventStore.EventStoreV2,
  Effect.gen(function* () {
    const base = yield* EventStore.EventStoreV2;
    const cache = yield* ThreadReadCache;
    return {
      ...base,
      publishCommitted: Effect.fnUntraced(function* (events) {
        yield* cache.invalidate(committedThreadIds(events));
        yield* base.publishCommitted(events);
      }),
    };
  }),
);

export const layerProjectionStore: Layer.Layer<
  ProjectionStore.ProjectionStoreV2,
  never,
  SqlClient.SqlClient | ThreadReadCache
> = Layer.effect(
  ProjectionStore.ProjectionStoreV2,
  Effect.gen(function* () {
    const base = yield* ProjectionStore.ProjectionStoreV2;
    const cache = yield* ThreadReadCache;
    const sql = yield* SqlClient.SqlClient;
    const cached = <A, E>(
      threadId: ThreadId,
      key: string,
      load: Effect.Effect<A, E>,
      keep: (value: A) => boolean,
    ) =>
      Effect.serviceOption(sql.transactionService).pipe(
        Effect.flatMap((transaction) =>
          Option.isSome(transaction) ? load : cache.read(threadId, key, load, keep),
        ),
      );
    const getThreadShell: ProjectionStore.ProjectionStoreV2Shape["getThreadShell"] = (threadId) =>
      cached(
        threadId,
        "shell",
        base.getThreadShell(threadId),
        (shell) => shell !== null && shell.forkedFrom == null,
      );
    const getTimelinePage: ProjectionStore.ProjectionStoreV2Shape["getTimelinePage"] = (
      threadId,
      options,
    ) =>
      getThreadShell(threadId).pipe(
        Effect.flatMap((shell) =>
          shell === null || shell.forkedFrom != null
            ? base.getTimelinePage(threadId, options)
            : cached(
                threadId,
                `timeline\u0000${JSON.stringify(options)}`,
                base.getTimelinePage(threadId, options),
                () => true,
              ),
        ),
      );
    const getThreadRecords: ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"] = (
      threadId,
      fields,
      filter,
    ) =>
      fields.some((field) => UNCACHED_RECORD_FIELDS.has(field))
        ? base.getThreadRecords(threadId, fields, filter)
        : cached(
            threadId,
            `records\u0000${JSON.stringify([fields, filter ?? null])}`,
            base.getThreadRecords(threadId, fields, filter),
            (records) => records.thread.forkedFrom == null,
          );
    return { ...base, getThreadShell, getTimelinePage, getThreadRecords };
  }),
).pipe(Layer.provide(ProjectionStore.layer));
