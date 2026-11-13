import {
  FORWARDED_SENDER_HEADER,
  OrchestratorMcpClientRequestId,
  OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import { finishRun, threadIsIdle } from "./threadRun.ts";
import { ThreadQueueHeldError } from "./ThreadQueueHeldError.ts";

const decodeRequestId = Schema.decodeUnknownEffect(OrchestratorMcpClientRequestId);

const resolveRequestId = Effect.fn("cli.thread.requestId")(function* (
  given: Option.Option<string>,
) {
  if (Option.isSome(given)) {
    return yield* decodeRequestId(given.value).pipe(
      Effect.mapError(() => new ThreadUsageError({ detail: "--request-id is not a valid key." })),
    );
  }
  const crypto = yield* SecureRandom.SecureRandom;
  const generated = yield* crypto.uuidV4().pipe(Effect.orDie);
  yield* Console.error(
    `Request id ${generated}. If this times out, rerun with --request-id ${generated} to deliver once.`,
  );
  return generated;
});

const agentThreadEnvironment = Config.all({
  threadId: Config.String("T3_THREAD_ID").pipe(Config.option),
  environmentId: Config.String("T3_ENVIRONMENT_ID").pipe(Config.option),
});

const encodeSender = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ threadId: Schema.String, environmentId: Schema.optional(Schema.String) }),
  ),
);

const resolveSenderHeaders = Effect.fn("cli.thread.sender")(function* (flags: {
  readonly from: Option.Option<string>;
  readonly asOwner: boolean;
}) {
  if (flags.asOwner && Option.isSome(flags.from)) {
    return yield* new ThreadUsageError({ detail: "Pass --from or --as-owner, not both." });
  }
  if (flags.asOwner) return undefined;
  const sender = Option.isSome(flags.from)
    ? { threadId: yield* decodeThreadId(flags.from.value) }
    : yield* agentThreadEnvironment.pipe(
        Effect.map(({ threadId, environmentId }) =>
          Option.isNone(threadId) || threadId.value.trim().length === 0
            ? undefined
            : {
                threadId: threadId.value.trim(),
                ...(Option.isSome(environmentId) ? { environmentId: environmentId.value } : {}),
              },
        ),
        Effect.orElseSucceed(() => undefined),
      );
  return sender === undefined ? undefined : { [FORWARDED_SENDER_HEADER]: encodeSender(sender) };
});

const receiptText = (sent: OrchestratorMcpThreadSendResult) =>
  sent.receipt === undefined
    ? ""
    : ` Receipt ${sent.receipt.commandId} (sequence ${sent.receipt.sequence})${
        sent.receipt.replayed ? ", already delivered" : ""
      }.`;

const deliveryText = (sent: OrchestratorMcpThreadSendResult) =>
  sent.delivery === "held"
    ? `Held (${sent.holdReason ?? "manual"}).${receiptText(sent)} ${sent.next ?? "Send with mode auto to start now."}`
    : `${sent.delivery === "queued" ? "Queued" : sent.delivery === "noted" ? "Noted" : "Sent"}.${receiptText(sent)}`;

export const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  thread: threadArgument,
  message: messageArgument,
  mode: Flag.Literals("mode", ["auto", "queue", "steer", "restart", "note"]).pipe(
    Flag.withDescription("How to deliver the message to the thread."),
    Flag.withDefault("queue"),
  ),
  requestId: Flag.String("request-id").pipe(
    Flag.withDescription(
      "Key that makes the send idempotent. Rerun with the same key, thread, message and mode after a timeout and the message is delivered once. Defaults to a new key, printed on stderr.",
    ),
    Flag.optional,
  ),
  from: Flag.String("from").pipe(
    Flag.withDescription(
      "Thread the message comes from, so clients show it as agent traffic. Defaults to T3_THREAD_ID, which T3 Code sets for the agents it runs.",
    ),
    Flag.optional,
  ),
  asOwner: Flag.Boolean("as-owner").pipe(
    Flag.withDescription(
      "Send it as the person's own words, with no sending thread, even when T3_THREAD_ID is set.",
    ),
    Flag.withDefault(false),
  ),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message: queue uses the next turn without interrupting; note shows it in the thread and gives it to the next turn as context without starting one; steer updates the running turn mid-turn; restart interrupts and restarts; auto starts an idle thread, steers a running turn, or queues.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const message = yield* readMessageArgument(flags.message);
      const senderHeaders = yield* resolveSenderHeaders(flags);
      const clientRequestId = yield* resolveRequestId(flags.requestId);
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.send")(function* (tools) {
          const followWakes = flags.wait ? yield* threadIsIdle(tools, threadId) : false;
          const sent = yield* tools.call(
            "t3_thread_send",
            { threadId, message, mode: flags.mode, clientRequestId },
            OrchestratorMcpThreadSendResult,
          );
          if (sent.delivery === "held") {
            yield* flags.json ? printJson(sent) : Console.log(deliveryText(sent));
            if (flags.wait) return yield* new ThreadQueueHeldError({ threadId });
            return;
          }
          if (flags.wait && sent.runId !== undefined) {
            yield* flags.json
              ? printJsonToStderr({
                  threadId,
                  runId: sent.runId,
                  clientRequestId,
                  receipt: sent.receipt,
                })
              : Console.error(deliveryText(sent));
            return yield* finishRun(tools, {
              threadId,
              runId: sent.runId,
              json: flags.json,
              followWakes,
              extra: { clientRequestId, receipt: sent.receipt },
            });
          }
          yield* flags.json ? printJson(sent) : Console.log(deliveryText(sent));
        }),
        senderHeaders,
      );
    }).pipe(reportThreadErrors),
  ),
);
