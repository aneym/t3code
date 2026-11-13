import {
  type ModelSelection,
  type OrchestratorMcpDelegateTaskInput,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as AgentPlacement from "../peer/AgentPlacement.ts";
import * as WorktreeTransfer from "../peer/WorktreeTransfer.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import { delegatedChildDefaultModel } from "./delegatedChildModel.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Orchestrator from "./OrchestratorMcpService.ts";
import { readCaller } from "./threadAccess.ts";

type Caller = Effect.Success<ReturnType<typeof readCaller>>["caller"];

const unpushedParentCommit = Effect.fn("AgentDelegation.unpushedParentCommit")(function* (
  parent: NonNullable<Caller>,
) {
  const transfer = yield* Effect.serviceOption(WorktreeTransfer.WorktreeTransfer);
  const projects = yield* Effect.serviceOption(Projects.ProjectService);
  if (Option.isNone(transfer)) return undefined;
  const checkout =
    parent.worktreePath ??
    (Option.isNone(projects)
      ? undefined
      : Option.getOrUndefined(
          yield* projects.value
            .getById(parent.projectId)
            .pipe(Effect.orElseSucceed(() => Option.none())),
        )?.workspaceRoot);
  if (checkout === undefined) return undefined;
  const base = yield* transfer.value
    .resolveBase(checkout)
    .pipe(Effect.orElseSucceed(() => undefined));
  return base === undefined || base.fetchable !== null
    ? undefined
    : `The parent's commit ${base.commit.slice(0, 12)} exists only here; it is on no remote branch.`;
});

const localOnlyReason = Effect.fn("AgentDelegation.localOnlyReason")(function* (
  input: OrchestratorMcpDelegateTaskInput,
  parent: Caller,
) {
  if (input.isolation !== "worktree") return "Shared isolation keeps the parent's workspace.";
  if (input.baseRef !== undefined)
    return input.baseRef.startsWith("origin/")
      ? undefined
      : "The task's base reference is local to this environment.";
  if (
    parent === undefined ||
    (input.target?.projectId !== undefined && input.target.projectId !== parent.projectId)
  )
    return undefined;
  return yield* unpushedParentCommit(parent);
});

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
  const settings = yield* Effect.serviceOption(Settings.ServerSettingsService);
  const delegatedChildModel = Option.isNone(settings)
    ? null
    : ((yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => undefined)))
        ?.delegatedChildModel ?? null);
  const instanceId =
    input.target?.providerInstanceId ??
    (input.target?.driverKind === undefined
      ? inherited?.instanceId
      : ProviderInstanceId.make(input.target.driverKind));
  const model =
    input.target?.model ??
    (instanceId === undefined || inherited === undefined
      ? undefined
      : delegatedChildDefaultModel(delegatedChildModel, instanceId, inherited));
  const options =
    input.target?.options ??
    (instanceId === inherited?.instanceId && model === inherited?.model
      ? inherited?.options
      : undefined);
  const modelSelection: ModelSelection | undefined =
    instanceId === undefined || model === undefined
      ? undefined
      : { instanceId, model, ...(options === undefined ? {} : { options }) };
  const stayReason =
    modelSelection === undefined
      ? "No model to match across environments; name target.model to let it move."
      : yield* localOnlyReason(input, caller.caller);
  const selected = yield* placement.value.select(scope, {
    operation: "delegate",
    projectId: input.target?.projectId,
    ...(modelSelection === undefined ? {} : { modelSelection }),
    driverKind: input.target?.driverKind,
    clientRequestId: input.clientRequestId,
    ...(stayReason === undefined ? {} : { localOnlyReason: stayReason }),
  });
  if (selected === undefined) return yield* service.delegateTask(scope, input);
  const { result, placement: receipt } = yield* placement.value.run(
    scope,
    selected,
    input.clientRequestId,
    (clientRequestId) =>
      service.delegateTask(scope, {
        ...input,
        clientRequestId,
        target: {
          ...input.target,
          environmentId: selected.placement.environmentId,
          projectId: selected.projectId,
        },
      }),
    service.delegateTask(scope, input),
  );
  const childThreadId = result.remoteChild?.threadId ?? result.childThreadId;
  if (childThreadId !== null) yield* placement.value.record(childThreadId, receipt);
  return { ...result, placement: receipt };
});
