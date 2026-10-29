import {
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  ThreadId,
  OrchestratorMcpCapabilitiesResult,
  OrchestrationV2DispatchCommandResult,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { projectLocationFlags } from "./config.ts";
import { printJson, withOwnerMcpTools } from "./ownerMcpTools.ts";
import {
  ThreadUsageError,
  decodeThreadId,
  jsonFlag,
  reportThreadErrors,
  threadArgument,
} from "./threadCommon.ts";

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
          const before = yield* tools.call("t3_thread_configure", { threadId }, Configuration);
          let after = before;
          if (Option.isSome(flags.effort)) {
            const effort = flags.effort.value;
            const selection = before.modelSelection;
            const capabilities = yield* tools.call(
              "orchestrator_capabilities",
              { search: selection.model },
              OrchestratorMcpCapabilitiesResult,
            );
            const provider = capabilities.providers.find(
              (item) => item.providerInstanceId === selection.instanceId,
            );
            const optionId =
              provider?.driverKind === "claudeAgent"
                ? "effort"
                : provider?.driverKind === "codex"
                  ? "reasoningEffort"
                  : undefined;
            const option = provider?.models
              .find((model) => model.id === selection.model)
              ?.options?.find((item) => item.id === optionId);
            if (optionId === undefined || !option?.values.includes(effort)) {
              return yield* new ThreadUsageError({
                detail: `Effort '${effort}' is not supported by this thread's provider and model.`,
              });
            }
            const options = selection.options ?? [];
            const modelSelection = {
              ...selection,
              options: options.some((item) => item.id === optionId)
                ? options.map((item) => (item.id === optionId ? { ...item, value: effort } : item))
                : [...options, { id: optionId, value: effort }],
            };
            yield* tools.call(
              "t3_thread_configure",
              { threadId, modelSelection },
              OrchestrationV2DispatchCommandResult,
            );
            after = yield* tools.call("t3_thread_configure", { threadId }, Configuration);
            if (
              !Equal.equals(after.modelSelection, modelSelection) ||
              after.runtimeMode !== before.runtimeMode ||
              after.interactionMode !== before.interactionMode
            ) {
              return yield* new ThreadUsageError({
                detail:
                  "Configuration readback did not match the requested effort and preserved settings.",
              });
            }
          }
          yield* printJson(after);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);
