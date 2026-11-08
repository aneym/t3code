import { ServerDrainStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import {
  McpServerNotRunningError,
  McpServerUnreachableError,
  McpToolFailedError,
  type OwnerMcpTools,
  printJson,
  reportCliErrors,
  withOwnerMcpTools,
} from "./ownerMcpTools.ts";

const WAIT_SLICE_MS = 60_000;

const DrainResult = Schema.Struct({
  ...ServerDrainStatus.fields,
  idle: Schema.optionalKey(Schema.Boolean),
  waitedMs: Schema.optionalKey(Schema.Number),
});
type DrainResult = typeof DrainResult.Type;

export class ServerDrainTimeoutError extends Schema.TaggedError<ServerDrainTimeoutError>()(
  "ServerDrainTimeoutError",
  { activeRuns: Schema.Number, timeoutSeconds: Schema.Number },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `${this.activeRuns} runs were still active after ${this.timeoutSeconds}s. Drain stays on and no run was stopped.`;
  }
}

const reportDrainErrors = reportCliErrors(
  Schema.is(
    Schema.Union([
      McpServerNotRunningError,
      McpServerUnreachableError,
      McpToolFailedError,
      ServerDrainTimeoutError,
    ]),
  ),
);

const flags = {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of human-readable output."),
    Flag.withDefault(false),
  ),
  wait: Flag.Boolean("wait").pipe(
    Flag.withDescription("Return once no runs are active on this server."),
    Flag.withDefault(false),
  ),
  timeout: Flag.Int("timeout").pipe(
    Flag.withDescription(
      "With --wait, stop waiting after this many seconds and report the runs still active. Never stops a run.",
    ),
    Flag.optional,
  ),
};

const awaitIdle = Effect.fn("cli.serverDrain.awaitIdle")(function* (
  tools: OwnerMcpTools,
  timeoutSeconds: Option.Option<number>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const deadline = Option.map(timeoutSeconds, (seconds) => startedAt + seconds * 1000);
  while (true) {
    const now = yield* Clock.currentTimeMillis;
    const left = Option.map(deadline, (at) => at - now);
    const slice = Option.match(left, {
      onNone: () => WAIT_SLICE_MS,
      onSome: (ms) => Math.max(0, Math.min(WAIT_SLICE_MS, ms)),
    });
    const result = yield* tools.call(
      "t3_server_drain",
      { action: "wait", timeoutMs: slice },
      DrainResult,
    );
    const waitedMs = (yield* Clock.currentTimeMillis) - startedAt;
    const last = Option.match(left, { onNone: () => false, onSome: (ms) => ms <= WAIT_SLICE_MS });
    if (result.idle === true || last) return { ...result, waitedMs };
  }
});

const describe = (result: DrainResult) =>
  [
    result.draining ? `drain: on since ${result.since}` : "drain: off",
    `active runs: ${result.activeRunIds.length}${result.activeRunIds.length === 0 ? "" : ` (${result.activeRunIds.join(", ")})`}`,
    `threads waiting to start: ${result.waitingThreadIds.length}`,
    ...(result.idle === undefined
      ? []
      : [
          result.idle
            ? `idle after ${Math.round((result.waitedMs ?? 0) / 1000)}s`
            : `still active after ${Math.round((result.waitedMs ?? 0) / 1000)}s`,
        ]),
  ].join("\n");

const drainCommand = (action: "on" | "off" | "status", description: string) =>
  Command.make(action, flags).pipe(
    Command.withDescription(description),
    Command.withHandler((input) =>
      withOwnerMcpTools(`server drain ${action}`, input, (tools) =>
        Effect.gen(function* () {
          const set = yield* tools.call("t3_server_drain", { action }, DrainResult);
          const result = input.wait ? yield* awaitIdle(tools, input.timeout) : set;
          yield* input.json ? printJson(result) : Console.log(describe(result));
          if (result.idle === false)
            return yield* new ServerDrainTimeoutError({
              activeRuns: result.activeRunIds.length,
              timeoutSeconds: Option.getOrElse(input.timeout, () => 0),
            });
        }),
      ).pipe(reportDrainErrors),
    ),
  );

export const serverCommand = Command.make("server").pipe(
  Command.withDescription("Operate the running T3 Code server."),
  Command.withSubcommands([
    Command.make("drain").pipe(
      Command.withDescription(
        "Hold new turns while running ones finish, for installs and restarts. New messages queue and start when drain is turned off or the server restarts.",
      ),
      Command.withSubcommands([
        drainCommand("on", "Queue every new turn until drain is off or the server restarts."),
        drainCommand("off", "Start queued turns and admit new ones again."),
        drainCommand("status", "Show whether drain is on, active runs and waiting threads."),
      ]),
    ),
  ]),
);
