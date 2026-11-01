import * as Effect from "effect/Effect";
import { assert } from "vite-plus/test";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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

export const assertMissingTranscript = Effect.fn("test.assertMissingTranscript")(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
) {
  const missing = yield* Effect.flip(
    runtime.resumeThread({
      providerThread: {
        ...providerThread,
        nativeThreadRef: {
          driver: providerThread.driver,
          nativeId: "native-thread-missing",
          strength: "strong",
        },
      },
    }),
  );
  assert.equal(missing._tag, "ProviderAdapterResumeThreadError");
});
