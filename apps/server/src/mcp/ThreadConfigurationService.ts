import * as ThreadMetadata from "./ThreadMetadataMcpService.ts";
import {
  type ModelSelection,
  type ThreadId,
  OrchestratorMcpFailure,
  RuntimeMode,
  ProviderInteractionMode,
  ModelSelection as ModelSelectionSchema,
  ThreadId as ThreadIdSchema,
} from "@t3tools/contracts";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Orchestrator from "./OrchestratorMcpService.ts";
import { readThread, newCommandId, dispatchFailure } from "./threadAccess.ts";

export const ThreadConfiguration = Schema.Struct({
  threadId: ThreadIdSchema,
  modelSelection: ModelSelectionSchema,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
type Input = {
  readonly threadId?: ThreadId | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly effort?: string | undefined;
};
const configure = Effect.fn("ThreadConfigurationService.configure")(function* (
  scope: Invocation.McpInvocationScope,
  input: Input,
) {
  if (input.effort !== undefined && input.modelSelection !== undefined)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Choose effort or modelSelection, not both.",
    });
  const {
    threads,
    projection: { thread },
  } = yield* readThread(input.threadId);
  let selection = input.modelSelection;
  let effortOption: string | undefined;
  if (input.effort !== undefined) {
    const service = yield* Effect.serviceOption(Orchestrator.OrchestratorMcpService);
    if (Option.isNone(service))
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Provider capabilities are unavailable.",
      });
    const capabilities = yield* service.value.capabilities(scope, {
      search: thread.modelSelection.model,
    });
    const model = capabilities.providers
      .find((provider) => provider.providerInstanceId === thread.modelSelection.instanceId)
      ?.models.find((model) => model.id === thread.modelSelection.model);
    const options =
      model?.options?.filter((option) => /^(?:.*effort|reasoning|variant)$/i.test(option.id)) ?? [];
    const option = options.length === 1 ? options[0] : undefined;
    if (option === undefined || !option.values.includes(input.effort))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Effort is not supported by this thread's provider and model.",
      });
    effortOption = option.id;
    selection = {
      ...thread.modelSelection,
      options: [
        ...(thread.modelSelection.options ?? []).filter((item) => item.id !== option.id),
        { id: option.id, value: input.effort },
      ],
    };
  }
  if (selection !== undefined) {
    yield* threads
      .dispatch({
        type: modelSelectionCommandType(thread.providerInstanceId, selection),
        threadId: thread.id,
        commandId: yield* newCommandId(),
        modelSelection: selection,
      })
      .pipe(Effect.mapError(dispatchFailure));
  }
  const {
    projection: { thread: after },
  } = yield* readThread(thread.id);
  if (effortOption !== undefined) {
    const value = after.modelSelection.options?.find((item) => item.id === effortOption)?.value;
    const normalized =
      input.effort === "ultracode" &&
      value === "xhigh" &&
      after.modelSelection.options?.some((item) => item.id === "ultracode" && item.value === true);
    if (value !== input.effort && !normalized)
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Configuration readback did not match the requested effort.",
      });
  }
  return {
    threadId: after.id,
    modelSelection: after.modelSelection,
    runtimeMode: after.runtimeMode,
    interactionMode: after.interactionMode,
  };
});
export class ThreadConfigurationService extends Context.Service<
  ThreadConfigurationService,
  {
    readonly configure: (
      scope: Invocation.McpInvocationScope,
      input: Input,
    ) => Effect.Effect<typeof ThreadConfiguration.Type, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadConfigurationService") {}
export const layer = Layer.effect(
  ThreadConfigurationService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const orchestrator = yield* Effect.serviceOption(Orchestrator.OrchestratorMcpService);
    const crypto = yield* Crypto.Crypto;
    return ThreadConfigurationService.of({
      configure: Effect.fn("ThreadConfigurationService.configureRequest")((scope, input) =>
        configure(scope, input).pipe(
          Effect.provideService(Invocation.McpInvocationContext, scope),
          Effect.provideService(ThreadManagement.ThreadManagementService, threads),
          (effect) =>
            Option.isSome(orchestrator)
              ? Effect.provideService(
                  effect,
                  Orchestrator.OrchestratorMcpService,
                  orchestrator.value,
                )
              : effect,
          Effect.provideService(Crypto.Crypto, crypto),
        ),
      ),
    });
  }),
);

export const toolkitLayer = Layer.mergeAll(layer, ThreadMetadata.layer).pipe(
  Layer.provideMerge(Orchestrator.layer),
);
