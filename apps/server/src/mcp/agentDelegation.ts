import {
  type ModelSelection,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as AgentPlacement from "../peer/AgentPlacement.ts";
import * as PlacementRoom from "../peer/PlacementRoom.ts";
import * as WorktreeTransfer from "../peer/WorktreeTransfer.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import { delegatedChildDefaultModel } from "./delegatedChildModel.ts";
import { withHold } from "./delegatedHold.ts";
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
    input.worktreeBase !== "parent" ||
    (input.target?.projectId !== undefined && input.target.projectId !== parent.projectId)
  )
    return undefined;
  return yield* unpushedParentCommit(parent);
});

const repositoryFailure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const resolveRepository = Effect.fn("AgentDelegation.resolveRepository")(function* (
  input: OrchestratorMcpDelegateTaskInput,
  here: string,
  float = false,
) {
  const repository = input.target?.repository;
  if (repository === undefined) return input;
  if (input.target?.projectId !== undefined)
    return yield* repositoryFailure("Pass target.repository or target.projectId, not both.");
  const settings = yield* Effect.serviceOption(Settings.ServerSettingsService);
  const current = Option.isNone(settings)
    ? undefined
    : yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  if (current?.agentPlacementByRoom !== true)
    return yield* repositoryFailure(
      "target.repository needs agentPlacementByRoom on this environment; pass target.projectId.",
    );
  const environmentId = input.target?.environmentId;
  if (float || (environmentId !== undefined && environmentId !== here)) return input;
  const projects = yield* Effect.serviceOption(Projects.ProjectService);
  const projectId = Option.isNone(projects)
    ? undefined
    : yield* PlacementRoom.localProject(projects.value, repository);
  if (projectId === undefined)
    return yield* repositoryFailure(
      `No single project here has repository ${repository}. Omit environmentId to place it on a machine that has it, or pass target.projectId.`,
    );
  const { repository: _repository, ...target } = input.target ?? {};
  return { ...input, target: { ...target, projectId } };
});

export const delegate = Effect.fn("AgentDelegation.delegate")(function* (
  request: OrchestratorMcpDelegateTaskInput,
) {
  const scope = yield* Invocation.McpInvocationContext;
  const service = yield* Orchestrator.OrchestratorMcpService;
  const placement = yield* Effect.serviceOption(AgentPlacement.AgentPlacement);
  const placed =
    request.target?.environmentId === undefined &&
    scope.linkedEnvironments !== false &&
    Option.isSome(placement) &&
    (yield* placement.value.enabled);
  const input = yield* resolveRepository(request, scope.environmentId, placed);
  if (!placed || Option.isNone(placement))
    return yield* withHold(yield* service.delegateTask(scope, input));
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
    repository: input.target?.repository,
    ...(modelSelection === undefined ? {} : { modelSelection }),
    driverKind: input.target?.driverKind,
    clientRequestId: input.clientRequestId,
    ...(stayReason === undefined ? {} : { localOnlyReason: stayReason }),
  });
  if (
    input.target?.repository !== undefined &&
    (selected === undefined || selected.projectId === undefined)
  )
    return yield* withHold(
      yield* service.delegateTask(scope, yield* resolveRepository(input, scope.environmentId)),
    );
  if (selected === undefined) return yield* withHold(yield* service.delegateTask(scope, input));
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
    resolveRepository(input, scope.environmentId).pipe(
      Effect.flatMap((fallback) => service.delegateTask(scope, fallback)),
    ),
  );
  const childThreadId = result.remoteChild?.threadId ?? result.childThreadId;
  if (childThreadId !== null) yield* placement.value.record(childThreadId, receipt);
  return yield* withHold({ ...result, placement: receipt });
});
