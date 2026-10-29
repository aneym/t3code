import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/cli";

import { type McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { openOwnerCliSession } from "./ownerCliSession.ts";
import { resolveCliAuthConfig } from "./config.ts";

export class McpServerNotRunningError extends Schema.TaggedError<McpServerNotRunningError>()(
  "McpServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

export class McpServerUnreachableError extends Schema.TaggedError<McpServerUnreachableError>()(
  "McpServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
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

export const withOwnerMcpTools = Effect.fn("cli.ownerMcp.withOwnerMcpTools")(function* <A, E, R>(
  command: string,
  flags: { readonly baseDir: Option.Option<string> },
  run: (tools: OwnerMcpTools) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new McpServerNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtimeState.value.origin;
    const session = yield* openOwnerCliSession(config, new URL("/mcp", origin).href, command).pipe(
      Effect.mapError((cause) => new McpServerUnreachableError({ origin, cause })),
    );
    return yield* run(makeOwnerMcpTools(session, origin));
  }).pipe(Effect.scoped);
});
