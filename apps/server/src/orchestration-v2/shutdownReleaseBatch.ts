import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

export const releaseInBoundedBatch = Effect.fn("ProviderSessionManager.releaseInBoundedBatch")(
  function* <Entry, Records, E, R, E2, R2>(input: {
    readonly entries: ReadonlyArray<Entry>;
    readonly release: (
      entry: Entry,
      collect: (records: Records) => boolean,
    ) => Effect.Effect<void, E, R>;
    readonly writeBatch: (records: ReadonlyArray<Records>) => Effect.Effect<void, E2, R2>;
  }) {
    const batch: Array<Records> = [];
    let collecting = true;
    const releases = yield* Effect.forEach(
      input.entries,
      (entry) =>
        input.release(entry, (records) => {
          if (!collecting) return false;
          batch.push(records);
          return true;
        }),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Fiber.await(releases).pipe(Effect.interruptible, Effect.timeoutOption("1 second"));
    collecting = false;
    yield* input.writeBatch(batch);
    yield* Fiber.join(releases);
  },
);
