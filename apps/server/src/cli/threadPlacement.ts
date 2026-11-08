import {
  AgentPlacementReceipt,
  type AgentPlacementScore,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import * as Option from "effect/Option";

import { projectLocationFlags } from "./config.ts";
import { printJson, withOwnerMcpTools, type OwnerMcpTools } from "./ownerMcpTools.ts";
import { decodeThreadId, jsonFlag, reportThreadErrors, threadArgument } from "./threadCommon.ts";

export const ThreadLaunchResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  runId: Schema.NullOr(RunId),
  placement: Schema.optional(AgentPlacementReceipt),
});

export const onEnvironment = (
  tools: OwnerMcpTools,
  environmentId: string | undefined,
): OwnerMcpTools =>
  environmentId === undefined
    ? tools
    : { call: (tool, args, schema) => tools.call(tool, { ...args, environmentId }, schema) };

const ThreadPlacementResult = Schema.Struct({
  placement: Schema.optional(AgentPlacementReceipt),
});

const GIB = 1024 * 1024 * 1024;
export const formatPlacementScore = (entry: AgentPlacementScore) =>
  [
    `  ${entry.label} (${entry.environmentId})`,
    entry.skipped === undefined
      ? `headroom ${entry.score.toFixed(2)}`
      : `skipped: ${entry.skipped}`,
    `weight ${entry.weight}`,
    entry.loadPerCore === null ? null : `load/core ${entry.loadPerCore.toFixed(2)}`,
    entry.availableMemoryRatio === null
      ? null
      : `memory ${Math.round(entry.availableMemoryRatio * 100)}% free`,
    entry.freeDiskBytes === null ? null : `disk ${(entry.freeDiskBytes / GIB).toFixed(0)} GiB free`,
  ]
    .filter((part) => part !== null)
    .join("  ");

export const threadPlacementCommand = Command.make("placement", {
  ...projectLocationFlags,
  thread: threadArgument,
  environment: Flag.String("environment").pipe(
    Flag.withDescription("Environment id the thread runs on, when it was placed on another one."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show where a thread runs and why it was placed there."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withOwnerMcpTools("thread", flags, (tools) =>
        Effect.gen(function* () {
          const { placement } = yield* onEnvironment(
            tools,
            Option.getOrUndefined(flags.environment),
          ).call("t3_thread_read", { threadId, limit: 1, runLimit: 1 }, ThreadPlacementResult);
          if (flags.json) return yield* printJson({ threadId, placement: placement ?? null });
          if (placement === undefined)
            return yield* Console.log("No placement was recorded for this thread.");
          yield* Console.log(`${placement.label}  ${placement.environmentId}`);
          yield* Console.log(placement.reason);
          for (const entry of placement.scores ?? [])
            yield* Console.log(formatPlacementScore(entry));
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);
