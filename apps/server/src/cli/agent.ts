import { AgentBindResult, AgentHomesSnapshot } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { baseDirFlag } from "./config.ts";
import {
  McpServerNotRunningError,
  McpServerUnreachableError,
  McpToolFailedError,
  reportCliErrors,
  printJson,
  withOwnerMcpTools,
} from "./ownerMcpTools.ts";
const reportErrors = reportCliErrors(
  Schema.is(
    Schema.Union([McpServerNotRunningError, McpServerUnreachableError, McpToolFailedError]),
  ),
);
const list = Command.make("list", {
  baseDir: baseDirFlag,
  json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler((flags) =>
    withOwnerMcpTools("agent", flags, (tools) =>
      Effect.gen(function* () {
        const result = yield* tools.call("t3_agent_list", {}, AgentHomesSnapshot);
        yield* flags.json
          ? printJson(result)
          : Console.log(
              result.homes
                .map(
                  (home) =>
                    `${home.handle}\t${home.displayName ?? home.handle}\t${home.binding?.threadId ?? "unbound"}`,
                )
                .join("\n"),
            );
      }),
    ).pipe(reportErrors),
  ),
);
const bind = Command.make("bind", {
  baseDir: baseDirFlag,
  agent: Argument.String("agent"),
  thread: Argument.String("thread"),
  environment: Flag.String("environment").pipe(Flag.optional),
  host: Flag.String("host").pipe(Flag.optional),
  by: Flag.String("by").pipe(Flag.optional),
  onlyIfUnbound: Flag.Boolean("if-unbound").pipe(Flag.withDefault(false)),
  json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withHandler((flags) =>
    withOwnerMcpTools("agent", flags, (tools) =>
      Effect.gen(function* () {
        const result = yield* tools.call(
          "t3_agent_bind",
          {
            handle: flags.agent,
            threadId: flags.thread,
            onlyIfUnbound: flags.onlyIfUnbound,
            ...Option.match(flags.environment, {
              onNone: () => ({}),
              onSome: (threadEnvironmentId) => ({ threadEnvironmentId }),
            }),
            ...Option.match(flags.host, { onNone: () => ({}), onSome: (host) => ({ host }) }),
            ...Option.match(flags.by, { onNone: () => ({}), onSome: (by) => ({ by }) }),
          },
          AgentBindResult,
        );
        yield* flags.json
          ? printJson(result)
          : Console.log(
              `${result.home.handle}: ${result.home.binding?.threadId} (${result.changed ? "bound" : "unchanged"})`,
            );
      }),
    ).pipe(reportErrors),
  ),
);
export const agentCommand = Command.make("agent").pipe(Command.withSubcommands([list, bind]));
