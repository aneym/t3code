import { type OrchestratorMcpDelegateTaskInput, ProviderInstanceId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as AgentPlacement from "../peer/AgentPlacement.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Orchestrator from "./OrchestratorMcpService.ts";
import { readCaller } from "./threadAccess.ts";

export const delegate = Effect.fn("AgentDelegation.delegate")(function* (
  input: OrchestratorMcpDelegateTaskInput,
) {
  const scope = yield* Invocation.McpInvocationContext;
  const service = yield* Orchestrator.OrchestratorMcpService;
  if (input.target?.environmentId !== undefined || scope.linkedEnvironments === false)
    return yield* service.delegateTask(scope, input);
  const placement = yield* Effect.serviceOption(AgentPlacement.AgentPlacement);
  if (Option.isNone(placement) || !(yield* placement.value.enabled))
    return yield* service.delegateTask(scope, input);
  const caller = yield* readCaller();
  const inherited = caller.caller?.modelSelection;
  const instanceId =
    input.target?.providerInstanceId ??
    (input.target?.driverKind === undefined
      ? inherited?.instanceId
      : ProviderInstanceId.make(input.target.driverKind));
  const model =
    input.target?.model ?? (instanceId === inherited?.instanceId ? inherited?.model : undefined);
  const options =
    input.target?.options ??
    (instanceId === inherited?.instanceId && model === inherited?.model
      ? inherited?.options
      : undefined);
  const selected = yield* placement.value.select(scope, {
    operation: "delegate",
    projectId: input.target?.projectId,
    ...(instanceId === undefined || model === undefined
      ? {}
      : { modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) } }),
    driverKind: input.target?.driverKind,
    clientRequestId: input.clientRequestId,
    ...(input.isolation !== "worktree"
      ? { localOnlyReason: "Shared isolation keeps the parent's workspace." }
      : input.target?.projectId !== undefined ||
          (input.baseRef !== undefined && !input.baseRef.startsWith("origin/"))
        ? { localOnlyReason: "The caller pinned the task's project." }
        : {}),
  });
  if (selected === undefined) return yield* service.delegateTask(scope, input);
  const remote = selected.placement.environmentId !== scope.environmentId;
  const result = yield* service.delegateTask(
    scope,
    remote
      ? {
          ...input,
          target: {
            ...input.target,
            environmentId: selected.placement.environmentId,
            projectId: selected.projectId,
            providerInstanceId: selected.modelSelection?.instanceId,
            model: selected.modelSelection?.model,
            options: selected.modelSelection?.options,
          },
        }
      : input,
  );
  const childThreadId = result.remoteChild?.threadId ?? result.childThreadId;
  if (childThreadId !== null) yield* placement.value.record(childThreadId, selected.placement);
  return { ...result, placement: selected.placement };
});
