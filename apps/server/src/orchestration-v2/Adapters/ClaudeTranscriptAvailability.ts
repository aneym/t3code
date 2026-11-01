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
    const localProject = input.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const localTranscript = input.path.join(
      input.projectsDir,
      localProject,
      `${input.nativeThreadId}.jsonl`,
    );
    const localExists = yield* input.fileSystem.exists(localTranscript);
    const projects = localExists
      ? Option.some([localProject])
      : yield* input.fileSystem.readDirectory(input.projectsDir).pipe(Effect.option);
    if (Option.isNone(projects)) return false;
    const candidates = projects.value;
    for (const project of candidates) {
      const transcript = input.path.join(
        input.projectsDir,
        project,
        `${input.nativeThreadId}.jsonl`,
      );
      if (!(yield* input.fileSystem.exists(transcript))) continue;
      const message = yield* input.fileSystem.stream(transcript).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) =>
          Option.match(decodeLine(line), {
            onNone: () => false,
            onSome: (entry) => entry.type === "user" || entry.type === "assistant",
          }),
        ),
        Stream.runHead,
      );
      if (Option.isSome(message)) return false;
    }
    return true;
  },
);
