import {
  type EnvironmentId,
  type ModelSelection,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import {
  ChildProvider,
  ClaimedSlot,
  type ClaimResult,
  SPILL_REFUSED,
} from "../orchestration-v2/DelegatedChildClaims.ts";
import * as Gate from "../orchestration-v2/DelegatedChildStartGate.ts";
import * as AgentPlacement from "../peer/AgentPlacement.ts";
import { requireAllowed } from "../peer/PlacementAllowed.ts";
import * as PlacementRoom from "../peer/PlacementRoom.ts";
import { SpillLaunch } from "../peer/PlacementSpill.ts";
import * as WorktreeTransfer from "../peer/WorktreeTransfer.ts";
import * as Projects from "../project/ProjectService.ts";
import { projectsAtAgentHome } from "../project/ProjectsByRepository.ts";
import * as Settings from "../serverSettings.ts";
import { delegatedChildDefaultModel } from "./delegatedChildModel.ts";
import { withDelegateKey } from "./delegateKeyLock.ts";
import * as DelegateRetry from "./delegateRetry.ts";
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
  if (Option.isNone(project)) return false;
  const found = yield* projectsAtAgentHome(projects.value, project.value.workspaceRoot).pipe(
    Effect.orElseSucceed(() => ({ matches: [], complete: false })),
  );
  return found.complete && found.matches.length === 1;
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

const LIGHT_STAY = "Light tasks stay on this machine.";

const lightRefusal = (input: OrchestratorMcpDelegateTaskInput, here: string) =>
  input.isolation === "worktree"
    ? 'Light tasks run in the parent\'s workspace. Drop isolation "worktree", or drop class "light" to run it in a worktree.'
    : input.target?.environmentId !== undefined && input.target.environmentId !== here
      ? 'Light tasks stay on this machine. Drop target.environmentId, or drop class "light" to send it to another machine.'
      : undefined;

const withoutTarget = (input: OrchestratorMcpDelegateTaskInput) => {
  if (input.target === undefined) return input;
  const { environmentId: _environmentId, projectId: _projectId, ...target } = input.target;
  return { ...input, target };
};

export const delegate = Effect.fn("AgentDelegation.delegate")(function* (
  request: OrchestratorMcpDelegateTaskInput,
) {
  const scope = yield* Invocation.McpInvocationContext;
  const service = yield* Orchestrator.OrchestratorMcpService;
  const key = request.clientRequestId;
  const parent = scope.thread?.threadId;
  if (request.class !== "light" || key === undefined || parent === undefined)
    return yield* delegateNew(scope, service, request);
  return yield* withDelegateKey(
    `${parent}\u0000${key}`,
    Effect.gen(function* () {
      if ((yield* DelegateRetry.delegateRetryOf(scope, key)) === undefined)
        return yield* delegateNew(scope, service, request);
      const input = withoutTarget(request);
      return yield* withHold(
        yield* withProvider(service.delegateTask(scope, input), input.target?.providerInstanceId),
      );
    }),
  );
});

const delegateNew = Effect.fn("AgentDelegation.delegateNew")(function* (
  scope: Invocation.McpInvocationScope,
  service: Orchestrator.OrchestratorMcpService["Service"],
  request: OrchestratorMcpDelegateTaskInput,
) {
  const placement = yield* Effect.serviceOption(AgentPlacement.AgentPlacement);
  const gate = Option.getOrUndefined(yield* Effect.serviceOption(Gate.DelegatedChildStartGate));
  const parentThreadId = scope.thread?.threadId;
  const light =
    request.class === "light" &&
    gate !== undefined &&
    parentThreadId !== undefined &&
    (yield* gate.marksLight(parentThreadId));
  const refusal = light ? lightRefusal(request, scope.environmentId) : undefined;
  if (refusal !== undefined) return yield* repositoryFailure(refusal);
  const allowed = request.target?.allowedEnvironmentIds;
  const named = request.target?.environmentId;
  if (named !== undefined) yield* requireAllowed(allowed, named);
  const { class: _class, ...plain } = request;
  const placed =
    request.target?.environmentId === undefined &&
    scope.linkedEnvironments !== false &&
    Option.isSome(placement) &&
    (yield* placement.value.enabled);
  const input = yield* resolveRepository(
    light ? request : plain,
    scope.environmentId,
    placed && !light,
  );
  if (named === undefined && (light || !placed))
    yield* requireAllowed(
      allowed,
      scope.environmentId,
      light ? LIGHT_STAY : "Automatic placement is off here.",
    );
  if (!placed || Option.isNone(placement))
    return yield* withHold(
      yield* withProvider(service.delegateTask(scope, input), input.target?.providerInstanceId),
    );
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
  const unclaim = (token: number | undefined) =>
    token === undefined || gate === undefined ? Effect.void : gate.unclaim(token);
  return yield* Effect.acquireUseRelease(
    current?.agentPlacementSpillWhenFull === true &&
      !light &&
      gate !== undefined &&
      parentThreadId !== undefined
      ? gate.claim({
          parentThreadId,
          ...(instanceId === undefined ? {} : { provider: instanceId }),
        })
      : Effect.succeed<ClaimResult>({}),
    (claim) =>
      Effect.gen(function* () {
        const spill = claim.wouldHold !== undefined;
        const stayReason = light
          ? LIGHT_STAY
          : modelSelection === undefined
            ? "No model to match across environments; name target.model to let it move."
            : yield* localOnlyReason(input, caller.caller, spill);
        const placing = place(scope, service, placement.value, input, {
          modelSelection,
          stayReason,
          spill,
          release: unclaim(claim.token),
        });
        const owned = withProvider(placing, instanceId);
        return yield* claim.token === undefined
          ? owned
          : owned.pipe(Effect.provideService(ClaimedSlot, { token: claim.token }));
      }),
    (claim) => unclaim(claim.token),
  );
});

const withProvider = <A, E, R>(effect: Effect.Effect<A, E, R>, instanceId: string | undefined) =>
  instanceId === undefined ? effect : Effect.provideService(effect, ChildProvider, { instanceId });

const refused = (error: { readonly message: string }) => error.message.startsWith(SPILL_REFUSED);

const place = Effect.fn("AgentDelegation.place")(function* (
  scope: Invocation.McpInvocationScope,
  service: Orchestrator.OrchestratorMcpService["Service"],
  placement: AgentPlacement.AgentPlacement["Service"],
  input: OrchestratorMcpDelegateTaskInput,
  options: {
    readonly modelSelection: ModelSelection | undefined;
    readonly stayReason: string | undefined;
    readonly spill: boolean;
    readonly release: Effect.Effect<void>;
  },
) {
  const { modelSelection, stayReason, spill } = options;
  const exclude: Array<EnvironmentId> = [];
  for (;;) {
    const selected = yield* placement.select(scope, {
      operation: "delegate",
      projectId: input.target?.projectId,
      repository: input.target?.repository,
      ...(modelSelection === undefined ? {} : { modelSelection }),
      driverKind: input.target?.driverKind,
      clientRequestId: exclude.length === 0 ? input.clientRequestId : undefined,
      ...(stayReason === undefined ? {} : { localOnlyReason: stayReason }),
      ...(spill ? { spill, exclude } : {}),
      allowed: input.target?.allowedEnvironmentIds,
    });
    if (
      input.target?.repository !== undefined &&
      (selected === undefined || selected.projectId === undefined)
    )
      return yield* withHold(
        yield* service.delegateTask(scope, yield* resolveRepository(input, scope.environmentId)),
      );
    if (selected === undefined) {
      yield* requireAllowed(
        input.target?.allowedEnvironmentIds,
        scope.environmentId,
        "Automatic placement is off here.",
      );
      return yield* withHold(yield* service.delegateTask(scope, input));
    }
    const there = selected.placement.environmentId;
    if (there !== scope.environmentId) yield* options.release;
    const attempt = yield* placement
      .run(
        scope,
        selected,
        input.clientRequestId,
        (clientRequestId) => {
          const sent = service.delegateTask(scope, {
            ...input,
            clientRequestId,
            target: { ...input.target, environmentId: there, projectId: selected.projectId },
          });
          return spill
            ? sent.pipe(Effect.provideService(SpillLaunch, { startOrRefuse: true }))
            : sent;
        },
        resolveRepository(input, scope.environmentId).pipe(
          Effect.flatMap((fallback) => service.delegateTask(scope, fallback)),
        ),
      )
      .pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => spill && refused(error),
          () => Effect.succeedNone,
        ),
      );
    if (Option.isNone(attempt)) {
      exclude.push(there);
      continue;
    }
    const { result, placement: receipt } = attempt.value;
    const childThreadId = result.remoteChild?.threadId ?? result.childThreadId;
    if (childThreadId !== null) yield* placement.record(childThreadId, receipt);
    return yield* withHold({ ...result, placement: receipt });
  }
});
