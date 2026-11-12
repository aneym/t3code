import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";

export const withCodexThreadSubscriptions = Effect.fn("CodexThreadSubscriptions.make")(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
) {
  const unsubscribed = new Set<string>();
  const threads = yield* KeyedLock.make<string>();
  const nativeId = (thread: Parameters<typeof runtime.resumeThread>[0]["providerThread"]) =>
    thread.nativeThreadRef?.nativeId ?? String(thread.id);
  const start = (
    input: ProviderAdapter.ProviderAdapterV2TurnInput,
    operation: typeof runtime.startTurn,
  ) =>
    threads.withLock(
      nativeId(input.providerThread),
      Effect.gen(function* () {
        const id = nativeId(input.providerThread);
        if (unsubscribed.has(id)) {
          yield* runtime.resumeThread({
            providerThread: input.providerThread,
            threadId: input.threadId,
            modelSelection: input.modelSelection,
            runtimePolicy: input.runtimePolicy,
          });
          unsubscribed.delete(id);
        }
        yield* operation(input);
      }),
    );
  return {
    ...runtime,
    resumeThread: (input) =>
      threads.withLock(
        nativeId(input.providerThread),
        runtime
          .resumeThread(input)
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => unsubscribed.delete(nativeId(input.providerThread))),
            ),
          ),
      ),
    startTurn: (input) => start(input, runtime.startTurn),
    ...(runtime.compactThread === undefined
      ? {}
      : {
          compactThread: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
            start(input, runtime.compactThread!),
        }),
    ...(runtime.unloadThread === undefined
      ? {}
      : {
          unloadThread: (input: Parameters<NonNullable<typeof runtime.unloadThread>>[0]) =>
            threads.withLock(
              nativeId(input.providerThread),
              Effect.sync(() => unsubscribed.add(nativeId(input.providerThread))).pipe(
                Effect.andThen(runtime.unloadThread!(input)),
              ),
            ),
        }),
  } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
});
