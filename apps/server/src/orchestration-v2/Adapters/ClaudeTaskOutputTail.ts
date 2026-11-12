import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** The SDK withholds stdout until tool results; tail task_started files for live output.
 * The private Claude layout can change; failures omit live output and retain the final result. */

const CLAUDE_TASK_OUTPUT_POLL_MS = 250;
/** Bound discovery when Claude never writes the file. */
const MAX_LOCATE_ATTEMPTS = 40;
/** Skip ahead of fast writers; only the tail is displayed. */
const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_SCAN_EVERY_ATTEMPTS = 20;
const MAX_PROJECT_NAME_LENGTH = 200;

/** Claude Code's task output directory for this cwd's project, or none where it has no uid (Windows). */
export function claudeTaskOutputRoot(
  environment: Readonly<Record<string, string | undefined>> | undefined,
  path: Path.Path,
  cwd: string | null,
  platform: NodeJS.Platform,
): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  // Claude Code's macOS build falls back to /tmp and ignores the TMPDIR that
  // launchd always sets. Its other builds use `os.tmpdir()`, which reads these
  // from the environment it was launched with. A relative value is relative
  // to Claude's working directory, not this server's.
  const fallback =
    platform === "darwin"
      ? "/tmp"
      : environment?.TMPDIR || environment?.TMP || environment?.TEMP || "/tmp";
  const base = environment?.CLAUDE_CODE_TMPDIR?.trim() || fallback;
  const project = path.resolve(cwd ?? ".").replace(/[^a-zA-Z0-9]/g, "-");
  return path.resolve(cwd ?? ".", base, `claude-${uid}`, project.slice(0, MAX_PROJECT_NAME_LENGTH));
}

const locate = Effect.fn("ClaudeTaskOutputTail.locate")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly scan: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (projectDirectory: string) => {
    const candidate = path.join(
      projectDirectory,
      input.sessionId,
      "tasks",
      `${input.taskId}.output`,
    );
    return fileSystem.exists(candidate).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map((found) => (found ? Option.some(candidate) : Option.none<string>())),
    );
  };
  const own = yield* exists(input.root);
  if (Option.isSome(own) || !input.scan) return own;
  const parent = path.dirname(input.root);
  const ownName = path.basename(input.root);
  const projects = yield* fileSystem.readDirectory(parent).pipe(Effect.orElseSucceed(() => []));
  for (const project of projects) {
    if (project === ownName) continue;
    const found = yield* exists(path.join(parent, project));
    if (Option.isSome(found)) return found;
  }
  return Option.none<string>();
});

/** Complete stop on tool result or turn end, then await the effect; it performs a final read before returning. */
export const tailClaudeTaskOutput = Effect.fn("ClaudeTaskOutputTail.tail")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly stop: Deferred.Deferred<void>;
  readonly onChunk: (chunk: string) => Effect.Effect<void>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const scanEvery = yield* Config.Int("T3CODE_CLAUDE_TASK_OUTPUT_SCAN_EVERY").pipe(
    Effect.orElseSucceed(() => DEFAULT_SCAN_EVERY_ATTEMPTS),
  );
  const pause = Deferred.await(input.stop).pipe(
    Effect.as(true),
    Effect.timeoutOrElse({
      duration: CLAUDE_TASK_OUTPUT_POLL_MS,
      orElse: () => Effect.succeed(false),
    }),
  );
  let file = Option.none<string>();
  for (let attempt = 0; Option.isNone(file); attempt += 1) {
    const lastAttempt = attempt + 1 >= MAX_LOCATE_ATTEMPTS;
    const scan = lastAttempt || (attempt + 1) % Math.max(1, scanEvery) === 0;
    file = yield* locate({ ...input, scan });
    if (Option.isSome(file)) break;
    if (lastAttempt || (yield* pause)) return;
  }
  const filePath = file.value;
  let decoder = new TextDecoder("utf-8", { fatal: false });
  let offset = 0;
  let last = yield* Deferred.isDone(input.stop);
  while (true) {
    const size = yield* fileSystem.stat(filePath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => offset),
    );
    if (size < offset) offset = 0;
    if (size > offset) {
      const start = size - offset > MAX_READ_BYTES ? size - MAX_READ_BYTES : offset;
      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(filePath, { flag: "r" });
          yield* handle.seek(BigInt(start), "start");
          return yield* handle.readAlloc(size - start);
        }),
      ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isSome(bytes)) {
        // Skipped output must not splice two unrelated lines together.
        const skipped = start > offset;
        // Reset partial UTF-8 bytes when skipping output.
        if (skipped) decoder = new TextDecoder("utf-8", { fatal: false });
        offset = start + bytes.value.byteLength;
        const text = (skipped ? "\n" : "") + decoder.decode(bytes.value, { stream: true });
        if (text.length > 0) yield* input.onChunk(text);
      }
    }
    if (last) {
      const rest = decoder.decode();
      if (rest.length > 0) yield* input.onChunk(rest);
      return;
    }
    last = yield* pause;
  }
});
