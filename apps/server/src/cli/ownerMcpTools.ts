import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Runtime from "effect/Runtime";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/cli";

import { SERVICE_STATE_FILE } from "../cloud/serviceProtocol.ts";
import type { McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { resolveCliAuthConfig } from "./config.ts";
import { openOwnerCliSession } from "./ownerCliSession.ts";

const SERVER_UNAVAILABLE_EXIT_CODE = 3;

const isServerUnavailable = (error: unknown) =>
  Predicate.isTagged(error, "McpServerNotRunningError") ||
  Predicate.isTagged(error, "McpServerUnreachableError");

export class McpServerNotRunningError extends Schema.TaggedError<McpServerNotRunningError>()(
  "McpServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = SERVER_UNAVAILABLE_EXIT_CODE;
  override get message(): string {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

export class McpServerUnreachableError extends Schema.TaggedError<McpServerUnreachableError>()(
  "McpServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = SERVER_UNAVAILABLE_EXIT_CODE;
  override get message(): string {
    const reason = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Could not reach the T3 Code server at ${this.origin}.${reason}`;
  }
}

export class McpToolFailedError extends Schema.TaggedError<McpToolFailedError>()(
  "McpToolFailedError",
  { tool: Schema.String, detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export const reportCliErrors =
  (isExpected: (error: unknown) => error is { readonly message: string }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((error) => (isExpected(error) ? Console.error(error.message) : Effect.void)),
    );

const decodeFailureText = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestratorMcpFailure));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const printJson = (value: unknown) => Console.log(encodeJson(value));
export const printJsonToStderr = (value: unknown) => Console.error(encodeJson(value));

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});

const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);

const toolFailureDetail = (result: typeof ToolResult.Type) => {
  const text = result.content?.find((part) => part.text !== undefined)?.text ?? "";
  return Option.match(decodeFailureText(text), {
    onNone: () => text || "The tool call failed.",
    onSome: (failure) => `${failure.code}: ${failure.message}`,
  });
};

const makeOwnerMcpTools = (session: McpToolSession, origin: string) => {
  const unexpected = (tool: string) =>
    new McpToolFailedError({
      tool,
      detail: `The server sent an unexpected ${tool} result. Update the t3 CLI to match the server.`,
    });
  return {
    call: Effect.fn("cli.ownerMcp.callTool")(function* <S extends Schema.Decoder<unknown>>(
      tool: string,
      args: Readonly<Record<string, unknown>>,
      schema: S,
    ): Effect.fn.Return<S["Type"], McpServerUnreachableError | McpToolFailedError> {
      const raw = yield* session
        .call(tool, args)
        .pipe(Effect.mapError((cause) => new McpServerUnreachableError({ origin, cause })));
      const result = yield* decodeToolResult(raw).pipe(Effect.mapError(() => unexpected(tool)));
      if (result.isError === true) {
        return yield* new McpToolFailedError({ tool, detail: toolFailureDetail(result) });
      }
      return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
        Effect.mapError(() => unexpected(tool)),
      );
    }),
  };
};
export type OwnerMcpTools = ReturnType<typeof makeOwnerMcpTools>;

export const ownerMcpToolsAt = (
  secretsDir: string,
  origin: string,
  command: string,
  headers?: Readonly<Record<string, string>>,
) =>
  openOwnerCliSession(secretsDir, origin, command, headers).pipe(
    Effect.map((session) => makeOwnerMcpTools(session, origin)),
    Effect.catchTags({
      AcpMcpBridgeError: (cause) => Effect.fail(new McpServerUnreachableError({ origin, cause })),
    }),
  );

const SERVICE_RESTART_WAIT = "2 minutes";

export const withOwnerMcpTools = Effect.fn("cli.ownerMcp.withOwnerMcpTools")(function* <A, E, R>(
  command: string,
  flags: { readonly baseDir: Option.Option<string>; readonly quietLogs?: boolean },
  run: (tools: OwnerMcpTools) => Effect.Effect<A, E, R>,
  headers?: Readonly<Record<string, string>>,
  serverWait?: Duration.Duration,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, {
    quietLogs: flags.quietLogs === true,
  });
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serviceInstalled = yield* fileSystem
    .exists(path.join(config.baseDir, "runtime", SERVICE_STATE_FILE))
    .pipe(Effect.orElseSucceed(() => false));
  const attempt = Effect.gen(function* () {
    const connect = Effect.gen(function* () {
      const runtimeState = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        return yield* new McpServerNotRunningError({ baseDir: config.baseDir });
      }
      return yield* ownerMcpToolsAt(config.secretsDir, runtimeState.value.origin, command, headers);
    });
    let told = false;
    const tools = yield* serviceInstalled && serverWait === undefined
      ? connect.pipe(
          Effect.tapError(() =>
            Effect.suspend(() => {
              if (told) return Effect.void;
              told = true;
              return Console.error(
                `T3 Code at ${config.baseDir} is restarting. Waiting up to ${SERVICE_RESTART_WAIT} for it.`,
              );
            }),
          ),
          Effect.retry({
            schedule: Schedule.spaced("250 millis").pipe(
              Schedule.upTo({ duration: SERVICE_RESTART_WAIT }),
            ),
            while: (error) =>
              error._tag === "McpServerNotRunningError" ||
              error._tag === "McpServerUnreachableError",
          }),
        )
      : connect;
    return yield* run(tools);
  }).pipe(Effect.scoped);
  let waiting = false;
  const delivered =
    serverWait === undefined
      ? attempt
      : attempt.pipe(
          Effect.tapError((error) =>
            Effect.suspend(() => {
              if (waiting || !isServerUnavailable(error)) return Effect.void;
              waiting = true;
              return Console.error(
                `T3 Code at ${config.baseDir} is not answering. Retrying for up to ${Duration.format(serverWait)}.`,
              );
            }),
          ),
          Effect.retry({
            schedule: Schedule.spaced("500 millis").pipe(Schedule.upTo({ duration: serverWait })),
            while: isServerUnavailable,
          }),
        );
  return yield* delivered;
});
