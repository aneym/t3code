import { ThreadId } from "@t3tools/contracts";
import * as Runtime from "effect/Runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Flag } from "effect/cli";

import {
  McpServerNotRunningError,
  McpServerUnreachableError,
  McpToolFailedError,
  reportCliErrors,
} from "./ownerMcpTools.ts";

export class ThreadUsageError extends Schema.TaggedError<ThreadUsageError>()("ThreadUsageError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export class ThreadProjectNotFoundError extends Schema.TaggedError<ThreadProjectNotFoundError>()(
  "ThreadProjectNotFoundError",
  { identifier: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No T3 Code project matches '${this.identifier}'. Pass a project id or a path inside a project.`;
  }
}

export class ThreadNeedsInputError extends Schema.TaggedError<ThreadNeedsInputError>()(
  "ThreadNeedsInputError",
  { threadId: ThreadId },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = 2;

  override get message(): string {
    return `Thread ${this.threadId} is waiting for an answer. Open it in T3 Code to respond.`;
  }
}

export class ThreadRunEndedError extends Schema.TaggedError<ThreadRunEndedError>()(
  "ThreadRunEndedError",
  { threadId: ThreadId, status: Schema.String, error: Schema.optional(Schema.String) },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.error === undefined ? "." : `: ${this.error}`;
    return `Thread ${this.threadId} stopped with status ${this.status}${reason}`;
  }
}

const ThreadCliError = Schema.Union([
  McpServerNotRunningError,
  McpServerUnreachableError,
  McpToolFailedError,
  ThreadUsageError,
  ThreadProjectNotFoundError,
  ThreadNeedsInputError,
  ThreadRunEndedError,
]);
export const reportThreadErrors = reportCliErrors(Schema.is(ThreadCliError));

export const readMessageArgument = Effect.fn("cli.thread.readMessage")(function* (
  argument: string,
) {
  const text =
    argument === "-"
      ? yield* Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        )
      : argument;
  if (text.trim().length === 0) {
    return yield* new ThreadUsageError({ detail: "The message is empty." });
  }
  return text;
});

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);
export const waitFlag = Flag.Boolean("wait").pipe(
  Flag.withDescription(
    "Wait for the agent to finish and print its reply. Exits 1 if the run fails and 2 if it waits for an answer.",
  ),
  Flag.withDefault(false),
);
export const messageArgument = Argument.String("message").pipe(
  Argument.withDescription("Message for the agent, or - to read it from stdin."),
);
export const threadArgument = Argument.String("thread").pipe(
  Argument.withDescription("Thread id."),
);

const decodeThreadIdValue = Schema.decodeUnknownEffect(ThreadId);
export const decodeThreadId = (value: string) =>
  decodeThreadIdValue(value.trim()).pipe(
    Effect.mapError(() => new ThreadUsageError({ detail: `'${value}' is not a thread id.` })),
  );
