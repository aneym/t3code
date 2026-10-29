import {
  OrchestratorMcpClientRequestId,
  OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, printJsonToStderr, withOwnerMcpTools } from "./ownerMcpTools.ts";
import {
  ThreadUsageError,
  decodeThreadId,
  jsonFlag,
  messageArgument,
  readMessageArgument,
  reportThreadErrors,
  threadArgument,
  waitFlag,
} from "./threadCommon.ts";
import { finishRun } from "./threadRun.ts";

const decodeRequestId = Schema.decodeUnknownEffect(OrchestratorMcpClientRequestId);

const resolveRequestId = Effect.fn("cli.thread.requestId")(function* (
  given: Option.Option<string>,
) {
  if (Option.isSome(given)) {
    return yield* decodeRequestId(given.value).pipe(
      Effect.mapError(() => new ThreadUsageError({ detail: "--request-id is not a valid key." })),
    );
  }
  const crypto = yield* Crypto.Crypto;
  const generated = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  yield* Console.error(
    `Request id ${generated}. If this times out, rerun with --request-id ${generated} to deliver once.`,
  );
  return generated;
});

const receiptText = (sent: OrchestratorMcpThreadSendResult) =>
  sent.receipt === undefined
    ? ""
    : ` Receipt ${sent.receipt.commandId} (sequence ${sent.receipt.sequence})${
        sent.receipt.replayed ? ", already delivered" : ""
      }.`;

export const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  thread: threadArgument,
  message: messageArgument,
  mode: Flag.Literals("mode", ["auto", "queue", "steer", "restart"]).pipe(
    Flag.withDescription("How to deliver the message to the thread."),
    Flag.withDefault("queue"),
  ),
  requestId: Flag.String("request-id").pipe(
    Flag.withDescription(
      "Key that makes the send idempotent. Rerun with the same key, thread, message and mode after a timeout and the message is delivered once. Defaults to a new key, printed on stderr.",
    ),
    Flag.optional,
  ),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message: queue uses the next turn without interrupting; steer updates the running turn mid-turn; restart interrupts and restarts; auto starts an idle thread, steers a running turn, or queues.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const message = yield* readMessageArgument(flags.message);
      const clientRequestId = yield* resolveRequestId(flags.requestId);
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.send")(function* (tools) {
          const sent = yield* tools.call(
            "t3_thread_send",
            { threadId, message, mode: flags.mode, clientRequestId },
            OrchestratorMcpThreadSendResult,
          );
          if (flags.wait) {
            yield* flags.json
              ? printJsonToStderr({
                  threadId,
                  runId: sent.runId,
                  clientRequestId,
                  receipt: sent.receipt,
                })
              : Console.error(`Sent.${receiptText(sent)}`);
            return yield* finishRun(tools, {
              threadId,
              runId: sent.runId,
              json: flags.json,
              extra: { clientRequestId, receipt: sent.receipt },
            });
          }
          yield* flags.json
            ? printJson(sent)
            : Console.log(`${sent.delivery === "queued" ? "Queued" : "Sent"}.${receiptText(sent)}`);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);
