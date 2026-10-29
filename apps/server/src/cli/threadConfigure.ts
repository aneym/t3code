import { ModelSelection, RuntimeMode, ProviderInteractionMode, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { projectLocationFlags } from "./config.ts";
import { printJson, withOwnerMcpTools } from "./ownerMcpTools.ts";
import { decodeThreadId, jsonFlag, reportThreadErrors, threadArgument } from "./threadCommon.ts";

const Configuration = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});

export const threadConfigureCommand = Command.make("configure", {
  ...projectLocationFlags,
  thread: threadArgument,
  effort: Flag.String("effort").pipe(
    Flag.withDescription("Effort supported by the current provider and model."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Read configuration or change effort, preserving model, other options and modes.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.configure")(function* (tools) {
          const configuration = yield* tools.call(
            "t3_thread_configure",
            {
              threadId,
              ...Option.match(flags.effort, {
                onNone: () => ({}),
                onSome: (effort) => ({ effort }),
              }),
            },
            Configuration,
          );
          yield* printJson(configuration);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);
