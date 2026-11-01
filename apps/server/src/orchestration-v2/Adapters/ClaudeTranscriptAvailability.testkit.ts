import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const makeChangeSignal = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const until = (predicate: () => boolean): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        while (!predicate()) yield* PubSub.take(subscription);
      }),
    );
  return { notify: PubSub.publish(changes, undefined), until };
});

export const writeWakeTranscripts = Effect.fn("test.writeWakeTranscripts")(function* (
  configDir: string,
  nativeId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = path.join(configDir, "projects", "sandbox");
  yield* fileSystem.makeDirectory(projects, { recursive: true });
  for (const id of [nativeId, "forked-native-session"]) {
    yield* fileSystem.writeFileString(path.join(projects, `${id}.jsonl`), '{"type":"user"}\n');
  }
});
