import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Path from "effect/Path";

const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);

export const claudeTranscriptUnavailable = Effect.fn("ClaudeAdapterV2.transcriptUnavailable")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly projectsDir: string;
    readonly path: Path.Path;
    readonly nativeThreadId: string;
    readonly cwd: string;
  }) {
    const hasMessages = Effect.fn("ClaudeAdapterV2.transcriptHasMessages")(function* (
      project: string,
    ) {
      const transcript = input.path.join(
        input.projectsDir,
        project,
        `${input.nativeThreadId}.jsonl`,
      );
      // Stray files beside the project dirs fail with ENOTDIR.
      if (!(yield* input.fileSystem.exists(transcript).pipe(Effect.orElseSucceed(() => false))))
        return false;
      return Option.isSome(
        yield* input.fileSystem.stream(transcript).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter((line) =>
            Option.match(decodeLine(line), {
              onNone: () => false,
              onSome: (entry) => entry.type === "user" || entry.type === "assistant",
            }),
          ),
          Stream.runHead,
        ),
      );
    });
    const localProject = input.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    if (yield* hasMessages(localProject)) return false;
    const projects = yield* input.fileSystem.readDirectory(input.projectsDir).pipe(Effect.option);
    if (Option.isNone(projects)) return false;
    // Any message in any transcript copy means Claude may still resume it.
    for (const project of projects.value) {
      if (project !== localProject && (yield* hasMessages(project))) return false;
    }
    return true;
  },
);
