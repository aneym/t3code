import { OrchestrationV2DispatchCommandResult } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { projectLocationFlags } from "./config.ts";
import { printJson, withOwnerMcpTools } from "./ownerMcpTools.ts";
import { decodeThreadId, jsonFlag, reportThreadErrors, threadArgument } from "./threadCommon.ts";

export const threadSendAllCommand = Command.make("send-all", {
  ...projectLocationFlags,
  thread: threadArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Release and send compatible queued messages together as one message."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.sendAll")(function* (tools) {
          const result = yield* tools.call(
            "t3_queue",
            { action: "send_all", threadId },
            OrchestrationV2DispatchCommandResult,
          );
          yield* flags.json ? printJson(result) : Console.log("Sent all.");
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);
