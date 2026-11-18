import {
  Persistence,
  StoredOrchestrationThreadSnapshot,
  makeStoredThreadSnapshotEncoder,
  makeThreadCacheWriteOrder,
} from "@t3tools/client-runtime/platform";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { inEmbedPage } from "./embedProtocol";
import {
  KEPT_VIEW_LIMITS,
  clearKeptViewsFor,
  loadKeptView,
  removeKeptView,
  saveKeptView,
} from "./embedKeptViews";

const decodeKeptView = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredOrchestrationThreadSnapshot),
);

type KeptViewOperation = "load-thread" | "save-thread" | "remove-thread" | "clear-environment";

const keptViewCall = <A>(operation: KeptViewOperation, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new Persistence.ConnectionPersistenceError({
        operation,
        message: `Could not ${operation.replaceAll("-", " ")} in the kept views: ${String(cause)}`,
      }),
  });

const makeKeptViewCache = Effect.fn("EmbedKeptViewCache.make")(function* () {
  const base = yield* Persistence.EnvironmentCacheStore;
  if (!inEmbedPage()) return base;
  const encode = makeStoredThreadSnapshotEncoder({
    format: "full",
    maxJsonLength: KEPT_VIEW_LIMITS.maxEntryLength,
  });
  const writeOrder = makeThreadCacheWriteOrder();
  const discard = (environmentId: EnvironmentId, threadId: ThreadId) =>
    keptViewCall("remove-thread", () => removeKeptView(environmentId, threadId)).pipe(
      Effect.ignore,
      Effect.as(Option.none()),
    );
  return Persistence.EnvironmentCacheStore.of({
    ...base,
    loadThread: Effect.fn("EmbedKeptViewCache.loadThread")(function* (environmentId, threadId) {
      const raw = yield* keptViewCall("load-thread", () => loadKeptView(environmentId, threadId));
      if (raw === undefined) return Option.none();
      return yield* decodeKeptView(raw).pipe(
        Effect.map((stored) =>
          stored.environmentId === environmentId && stored.threadId === threadId
            ? Option.some(stored.snapshot)
            : Option.none(),
        ),
        Effect.catch(() => discard(environmentId, threadId)),
      );
    }),
    saveThread: Effect.fn("EmbedKeptViewCache.saveThread")(function* (environmentId, snapshot) {
      const threadId = snapshot.projection.thread.id;
      const isLatest = writeOrder.beginSave(environmentId, threadId);
      const encoded = yield* encode({ environmentId, threadId, snapshot }).pipe(
        Effect.mapError(
          (cause) =>
            new Persistence.ConnectionPersistenceError({
              operation: "save-thread",
              message: `Could not encode a kept view: ${String(cause)}`,
            }),
        ),
      );
      if (!isLatest()) return;
      yield* keptViewCall("save-thread", () =>
        Option.isSome(encoded)
          ? saveKeptView(environmentId, threadId, encoded.value)
          : removeKeptView(environmentId, threadId),
      );
    }),
    removeThread: Effect.fn("EmbedKeptViewCache.removeThread")(function* (environmentId, threadId) {
      writeOrder.removeThread(environmentId, threadId);
      yield* keptViewCall("remove-thread", () => removeKeptView(environmentId, threadId));
    }),
    clear: Effect.fn("EmbedKeptViewCache.clear")(function* (environmentId) {
      writeOrder.clearEnvironment(environmentId);
      yield* Effect.all(
        [
          base.clear(environmentId),
          keptViewCall("clear-environment", () => clearKeptViewsFor(environmentId)),
        ],
        { concurrency: "unbounded", discard: true },
      );
    }),
  });
});

export const layer = Layer.effect(Persistence.EnvironmentCacheStore, makeKeptViewCache());
