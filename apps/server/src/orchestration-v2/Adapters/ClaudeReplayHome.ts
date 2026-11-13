import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const makeReplayRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmpRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-replay-tasks-" });
  yield* fileSystem.makeDirectory(path.join(tmpRoot, "claude-home"));
  return tmpRoot;
});

export const claudeReplayEnvironment = (tmpRoot: string) => [
  { name: "CLAUDE_CODE_TMPDIR", value: tmpRoot, sensitive: false },
  { name: "CLAUDE_CONFIG_DIR", value: `${tmpRoot}/claude-home`, sensitive: false },
  { name: "ENABLE_TOOL_SEARCH", value: "true", sensitive: false },
];
