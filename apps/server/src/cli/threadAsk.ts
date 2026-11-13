import { NonNegativeInt, OrchestratorMcpThreadSendResult, ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, withOwnerMcpTools } from "./ownerMcpTools.ts";
import {
  decodeThreadId,
  jsonFlag,
  messageArgument,
  readMessageArgument,
  reportThreadErrors,
  threadArgument,
  waitFlag,
} from "./threadCommon.ts";
import { finishRun } from "./threadRun.ts";

const ForkResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });

export const threadAskCommand = Command.make("ask", {
  ...projectLocationFlags,
  thread: threadArgument,
  message: messageArgument,
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Ask a Claude thread something while it works: a one-time ask-only fork answers, reading but not acting, and is archived after its answer.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const message = yield* readMessageArgument(flags.message);
      const clientRequestId = yield* SecureRandom.SecureRandom.pipe(
        Effect.flatMap((crypto) => crypto.uuidV4()),
        Effect.orDie,
      );
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.ask")(function* (tools) {
          const fork = yield* tools.call(
            "t3_thread_transfer",
            { action: "fork", threadId, askOnly: true },
            ForkResult,
          );
          const sent = yield* tools.call(
            "t3_thread_send",
            { threadId: fork.targetThreadId, message, mode: "auto", clientRequestId },
            OrchestratorMcpThreadSendResult,
          );
          if (!flags.wait || sent.runId === undefined) {
            return yield* flags.json
              ? printJson(sent)
              : Console.log(`Asked fork ${fork.targetThreadId}, run ${sent.runId}.`);
          }
          return yield* finishRun(tools, {
            threadId: fork.targetThreadId,
            runId: sent.runId,
            json: flags.json,
            extra: { sourceThreadId: threadId },
            includeRun: flags.json,
          });
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);
