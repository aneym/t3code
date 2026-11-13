import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Path from "effect/Path";

const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);

const isConversationLine = (line: string): boolean =>
  Option.match(decodeLine(line), {
    onNone: () => false,
    onSome: (entry) => entry.type === "user" || entry.type === "assistant",
  });

export type ClaudeTranscriptState = "conversation" | "empty" | "missing" | "unreadable";

export const readClaudeTranscriptState = Effect.fn("ClaudeAdapterV2.claudeTranscriptState")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly projectsDir: string;
    readonly path: Path.Path;
    readonly nativeThreadId: string;
    readonly cwd: string;
  }) {
    const copyState = Effect.fn("ClaudeAdapterV2.transcriptCopyState")(function* (project: string) {
      const transcript = input.path.join(
        input.projectsDir,
        project,
        `${input.nativeThreadId}.jsonl`,
      );
      // Stray files beside the project dirs fail with ENOTDIR.
      if (!(yield* input.fileSystem.exists(transcript).pipe(Effect.orElseSucceed(() => false))))
        return "missing" as const;
      const line = yield* input.fileSystem
        .stream(transcript)
        .pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter(isConversationLine),
          Stream.runHead,
          Effect.option,
        );
      if (Option.isNone(line)) return "unreadable" as const;
      return Option.isSome(line.value) ? ("conversation" as const) : ("empty" as const);
    });
    const localProject = input.cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const local = yield* copyState(localProject);
    if (local === "conversation") return local;
    const projects = yield* input.fileSystem.readDirectory(input.projectsDir).pipe(Effect.option);
    if (Option.isNone(projects)) return "unreadable" as const;
    // Any message in any transcript copy means Claude may still resume it.
    const states: Array<ClaudeTranscriptState> = [local];
    for (const project of projects.value) {
      if (project === localProject) continue;
      const copy = yield* copyState(project);
      if (copy === "conversation") return copy;
      states.push(copy);
    }
    if (states.includes("unreadable")) return "unreadable" as const;
    return states.includes("empty") ? ("empty" as const) : ("missing" as const);
  },
);
