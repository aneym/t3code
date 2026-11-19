import {
  type ModelSelection,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { agentHomeKeyOfRoot } from "../agents/AgentHomeOfPath.ts";
import { ClaimedSlot } from "../orchestration-v2/DelegatedChildClaims.ts";
import * as Gate from "../orchestration-v2/DelegatedChildStartGate.ts";
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

const homeProject = Effect.fn("AgentDelegation.homeProject")(function* (
  input: OrchestratorMcpDelegateTaskInput,
  parent: Caller,
) {
  const projectId = input.target?.projectId ?? parent?.projectId;
  const projects = yield* Effect.serviceOption(Projects.ProjectService);
  if (projectId === undefined || Option.isNone(projects)) return false;
  const project = yield* projects.value
    .getById(projectId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return (
    Option.isSome(project) &&
    (yield* Effect.promise(() => agentHomeKeyOfRoot(project.value.workspaceRoot))) !== undefined
  );
});

const localOnlyReason = Effect.fn("AgentDelegation.localOnlyReason")(function* (
  input: OrchestratorMcpDelegateTaskInput,
  parent: Caller,
  spill: boolean,
) {
  if (input.isolation !== "worktree")
    return spill && (yield* homeProject(input, parent))
      ? undefined
      : "Shared isolation keeps the parent's workspace.";
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
  const current = Option.isNone(settings)
    ? undefined
    : yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  const delegatedChildModel = current?.delegatedChildModel ?? null;
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
  const gate = yield* Effect.serviceOption(Gate.DelegatedChildStartGate);
  const parentThreadId = scope.thread?.threadId;
  const claim =
    current?.agentPlacementSpillWhenFull === true &&
    Option.isSome(gate) &&
    parentThreadId !== undefined
      ? yield* gate.value.claim({ parentThreadId })
      : {};
  const spill = claim.wouldHold !== undefined;
  const token = claim.token;
  const claimed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    token === undefined || Option.isNone(gate)
      ? effect
      : effect.pipe(
          Effect.provideService(ClaimedSlot, ClaimedSlot.of({ token })),
          Effect.ensuring(gate.value.unclaim(token)),
        );
  const stayReason =
    modelSelection === undefined
      ? "No model to match across environments; name target.model to let it move."
      : yield* localOnlyReason(input, caller.caller, spill);
  return yield* claimed(
    place(scope, service, placement.value, input, modelSelection, stayReason, spill),
  );
});

const place = Effect.fn("AgentDelegation.place")(function* (
  scope: Invocation.McpInvocationScope,
  service: Orchestrator.OrchestratorMcpService["Service"],
  placement: AgentPlacement.AgentPlacement["Service"],
  input: OrchestratorMcpDelegateTaskInput,
  modelSelection: ModelSelection | undefined,
  stayReason: string | undefined,
  spill: boolean,
) {
  const selected = yield* placement.select(scope, {
    operation: "delegate",
    projectId: input.target?.projectId,
    repository: input.target?.repository,
    ...(modelSelection === undefined ? {} : { modelSelection }),
    driverKind: input.target?.driverKind,
    clientRequestId: input.clientRequestId,
    ...(stayReason === undefined ? {} : { localOnlyReason: stayReason }),
    ...(spill ? { spill } : {}),
  });
  if (
    input.target?.repository !== undefined &&
    (selected === undefined || selected.projectId === undefined)
  )
    return yield* withHold(
      yield* service.delegateTask(scope, yield* resolveRepository(input, scope.environmentId)),
    );
  if (selected === undefined) return yield* withHold(yield* service.delegateTask(scope, input));
  const { result, placement: receipt } = yield* placement.run(
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
  if (childThreadId !== null) yield* placement.record(childThreadId, receipt);
  return yield* withHold({ ...result, placement: receipt });
});
