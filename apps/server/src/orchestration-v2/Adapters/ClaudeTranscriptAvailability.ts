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
  }) {
    const projects = yield* input.fileSystem.readDirectory(input.projectsDir).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
    );
    for (const project of projects) {
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
