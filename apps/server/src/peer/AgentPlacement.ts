import {
  AgentPlacementReceipt,
  type AgentPlacementRoom,
  type AgentPlacementScore,
  EnvironmentId,
  ModelSelection,
  OrchestratorMcpFailure,
  ProjectId,
  type ProviderDriverKind,
  linkOriginIsFenced,
  scoreAgentPlacement,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Resources from "../resourceTelemetry/HostResources.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Peers from "./PeerMcpClient.ts";
import * as Links from "./PeerLinks.ts";
import * as PlacementSnapshots from "./PlacementSnapshots.ts";
import * as PlacementDecisions from "./PlacementDecisions.ts";
import * as PlacementReceipts from "./PlacementReceipts.ts";
import * as PlacementWeights from "./PlacementWeights.ts";
import * as PlacementFallback from "./PlacementFallback.ts";
import { pickWinner, placementKeys, spillSkip } from "./PlacementSpill.ts";
import * as Room from "./PlacementRoom.ts";
import * as Claims from "./PlacementClaims.ts";
import { pinnedPlacement } from "./PlacementPin.ts";
import { allowedSkip, requireAllowed } from "./PlacementAllowed.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { assertLiveCaller, readCaller, unavailable } from "../mcp/threadAccess.ts";
import { callerLinkOrigin } from "../mcp/linkOrigin.ts";
import { requestPrincipal } from "../mcp/ownerCliSession.ts";

export type Selected = PlacementFallback.Selected;

export class AgentPlacement extends Context.Service<
  AgentPlacement,
  {
    readonly enabled: Effect.Effect<boolean>;
    readonly select: (
      scope: Invocation.McpInvocationScope,
      input: {
        readonly operation: "launch" | "delegate";
        readonly projectId?: ProjectId | undefined;
        readonly repository?: string | undefined;
        readonly modelSelection?: ModelSelection | undefined;
        readonly driverKind?: ProviderDriverKind | undefined;
        readonly clientRequestId?: string | undefined;
        readonly localOnlyReason?: string | undefined;
        readonly spill?: boolean | undefined;
        readonly exclude?: ReadonlyArray<EnvironmentId> | undefined;
        readonly allowed?: ReadonlyArray<EnvironmentId> | undefined;
      },
    ) => Effect.Effect<Selected | undefined, OrchestratorMcpFailure>;
    readonly run: PlacementFallback.Run;
    readonly record: (
      threadId: string,
      placement: AgentPlacementReceipt | undefined,
    ) => Effect.Effect<void>;
    readonly read: (threadId: string) => Effect.Effect<AgentPlacementReceipt | undefined>;
  }
>()("t3/peer/AgentPlacement") {}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const projects = yield* Projects.ProjectService;
  const identities = yield* Identities.RepositoryIdentityResolver;
  const providers = yield* Providers.ProviderRegistry;
  const resources = yield* Resources.HostResources;
  const environment = yield* Environment.ServerEnvironment;
  const peers = yield* Peers.PeerMcpClient;
  const links = yield* Links.PeerLinks;
  const config = yield* Config.ServerConfig;
  const threads = yield* Threads.ThreadManagementService;
  const lock = yield* KeyedLock.make<string>();
  const random = yield* SecureRandom.SecureRandom;
  const { record, read } = yield* PlacementReceipts.make;
  const snapshots = yield* PlacementSnapshots.make(peers);
  const decisions = yield* PlacementDecisions.make(config.stateDir);
  const claims = Claims.make();
  const serial = yield* Semaphore.make(1);
  const enabled = settings.getSettings.pipe(
    Effect.map(
      (current) =>
        current.agentLoadBalancingEnabled &&
        current.linkedEnvironmentsEnabled &&
        current.loadBalancingIncludeLinkedEnvironments,
    ),
    Effect.orElseSucceed(() => false),
  );

  const choose: AgentPlacement["Service"]["select"] = Effect.fn("AgentPlacement.choose")(
    function* (scope, input) {
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      if (
        !current.agentLoadBalancingEnabled ||
        !current.linkedEnvironmentsEnabled ||
        !current.loadBalancingIncludeLinkedEnvironments ||
        scope.linkedEnvironments === false
      )
        return undefined;
      const caller = yield* readCaller().pipe(
        Effect.provideService(Invocation.McpInvocationContext, scope),
        Effect.provideService(Threads.ThreadManagementService, threads),
      );
      const descriptor = yield* environment.getDescriptor;
      const atStart = current.agentPlacementAtStart;
      const roomOn = current.agentPlacementByRoom || atStart;
      const claimHere = atStart && allowedSkip(input.allowed, scope.environmentId) === undefined;
      const repository = roomOn ? input.repository : undefined;
      const projectId =
        repository === undefined
          ? (input.projectId ?? caller.caller?.projectId)
          : yield* Room.localProject(projects, repository);
      if (
        input.projectId !== undefined &&
        Option.isNone(
          yield* projects.getById(input.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
        )
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Project ${input.projectId} is not in this environment. Project ids belong to one environment: pass a project from t3_project_list here, or name the environment it belongs to.`,
        });
      const modelSelection =
        input.modelSelection ??
        caller.caller?.modelSelection ??
        (projectId === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* projects.getById(projectId).pipe(Effect.orElseSucceed(() => Option.none())),
            )?.defaultModelSelection) ??
        undefined;
      const local = (
        reason: string,
        scores?: ReadonlyArray<AgentPlacementScore>,
        decidedAt?: number,
      ): PlacementDecisions.Selection => ({
        placement: {
          environmentId: scope.environmentId,
          label: descriptor.label,
          reason,
          mode: "local",
          ...(decidedAt === undefined ? {} : { decidedAt }),
          ...(scores === undefined ? {} : { scores }),
        },
        ...(projectId === undefined ? {} : { projectId }),
        ...(modelSelection === undefined ? {} : { modelSelection }),
      });
      const origin = callerLinkOrigin(caller);
      if ((origin !== undefined && linkOriginIsFenced(origin)) || scope.client?.linked === true)
        return local("Placement was resolved by the originating environment.");
      if (input.localOnlyReason !== undefined) {
        if (claimHere)
          claims.claim(
            scope.environmentId,
            yield* Room.localRoom,
            false,
            DateTime.toEpochMillis(yield* DateTime.now),
          );
        return local(input.localOnlyReason);
      }
      if ((projectId === undefined && repository === undefined) || modelSelection === undefined)
        return local("No project or model to match across environments.");
      if (
        scope.client?.access === "read-only" ||
        caller.limits.runtimeMode !== "full-access" ||
        caller.limits.interactionMode !== "default"
      )
        return local("The caller's permissions keep automatic placement local.");
      yield* assertLiveCaller(caller);
      const digest =
        input.clientRequestId === undefined
          ? undefined
          : yield* decisions
              .keyOf({
                principal: requestPrincipal(scope),
                operation: input.operation,
                clientRequestId: input.clientRequestId,
                target: projectId ?? repository ?? "",
                modelSelection,
                driverKind: input.driverKind,
                allowed: input.allowed,
              })
              .pipe(Effect.mapError(unavailable));
      const keyed = (selection: PlacementDecisions.Selection): Selected =>
        digest === undefined ? selection : { ...selection, decisionKey: digest };
      const decide = Effect.gen(function* () {
        if (!(yield* enabled)) return undefined;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (digest !== undefined) {
          const saved = yield* decisions.load(digest, now);
          if (saved !== undefined) return keyed(saved);
        }
        const evaluate = Effect.gen(function* () {
          const project =
            projectId === undefined
              ? undefined
              : yield* projects.getById(projectId).pipe(Effect.map(Option.getOrUndefined));
          const spill = input.spill === true;
          const keys = yield* placementKeys(identities, project?.workspaceRoot, repository, spill);
          if (keys.length === 0)
            return local("No repository identity to match across environments.");
          const localProviders = yield* providers.getProviders;
          const selectedProvider = localProviders.find(
            (provider) => provider.instanceId === modelSelection.instanceId,
          );
          const driver = input.driverKind ?? selectedProvider?.driver;
          const line = current.agentPlacementHealthLine;
          const weightOf = (environmentId: EnvironmentId) =>
            PlacementWeights.callerWeight(current.agentLoadBalancingWeights[environmentId]);
          const linked =
            current.linkedEnvironmentsEnabled &&
            current.loadBalancingIncludeLinkedEnvironments &&
            scope.linkedEnvironments !== false
              ? (yield* links.stored.pipe(Effect.orElseSucceed(() => []))).filter(
                  (link) =>
                    link.access === "full-access" && DateTime.toEpochMillis(link.expiresAt) > now,
                )
              : [];
          yield* snapshots
            .refresh({
              environmentIds: linked
                .filter(
                  (link) =>
                    weightOf(link.environmentId) > 0 &&
                    allowedSkip(input.allowed, link.environmentId) === undefined,
                )
                .map((link) => link.environmentId),
              keys,
              limits: caller.limits,
              now,
            })
            .pipe(Effect.timeout(`${PlacementSnapshots.READ_SECONDS + 2} seconds`), Effect.ignore);
          return yield* Effect.gen(function* () {
            const scores: Array<AgentPlacementScore> = [];
            const matching = new Map<EnvironmentId, ProjectId>();
            const byRoom = roomOn || spill;
            const readings = new Map<EnvironmentId, AgentPlacementRoom | undefined>();
            const localSkipped =
              allowedSkip(input.allowed, scope.environmentId) ??
              Room.localSkip(selectedProvider, current, projectId, modelSelection);
            const localRoom = byRoom ? yield* Room.localRoom : undefined;
            readings.set(scope.environmentId, localRoom);
            const localScore = scoreAgentPlacement({
              ...claims.adjust(
                scope.environmentId,
                { room: localRoom, resources: yield* resources.read },
                now,
                atStart,
              ),
              environmentId: scope.environmentId,
              label: descriptor.label,
              weight: weightOf(scope.environmentId),
              line,
              now,
            });
            if (localSkipped === undefined && projectId !== undefined)
              matching.set(scope.environmentId, projectId);
            scores.push(
              localSkipped === undefined
                ? localScore
                : { ...localScore, score: 0, skipped: localSkipped },
            );
            const scoredAt = DateTime.toEpochMillis(yield* DateTime.now);
            for (const link of linked) {
              const entry = snapshots.cached(link.environmentId, keys, now);
              const snapshot = entry?.value;
              const sources = {
                callerEntry: current.agentLoadBalancingWeights[link.environmentId],
                own: snapshot?.placementWeight,
                label: snapshot?.label ?? link.label,
              };
              const reading = byRoom ? snapshot?.placementRoom : undefined;
              readings.set(link.environmentId, reading);
              const scored = scoreAgentPlacement({
                ...claims.adjust(
                  link.environmentId,
                  { room: reading, resources: snapshot?.hostResources },
                  scoredAt,
                  atStart,
                ),
                environmentId: link.environmentId,
                label: sources.label,
                weight: PlacementWeights.linkedWeight(sources),
                line: snapshot?.placementHealthLine ?? line,
                now: scoredAt,
              });
              const skipped =
                allowedSkip(input.allowed, link.environmentId) ??
                Room.peerSkip({
                  scored,
                  snapshot,
                  failure:
                    entry?.failure ?? `No reply within ${PlacementSnapshots.READ_SECONDS} s.`,
                  modelSelection,
                  driver,
                }) ??
                (spill ? spillSkip(scored.room, link.environmentId, input.exclude) : undefined);
              if (skipped === undefined && snapshot?.placementProjectId !== undefined)
                matching.set(link.environmentId, snapshot.placementProjectId);
              scores.push(
                PlacementWeights.explainWeight(
                  skipped === undefined ? scored : { ...scored, score: 0, skipped },
                  sources,
                ),
              );
            }
            const decided = (
              environmentId: EnvironmentId,
              mode: "auto" | "pinned",
              reason: string,
              hold?: PlacementDecisions.Selection["placement"]["hold"],
            ): PlacementDecisions.Selection => {
              const chosen = scores.find((entry) => entry.environmentId === environmentId);
              const mapped = matching.get(environmentId) ?? projectId;
              if (atStart || (byRoom && environmentId !== scope.environmentId))
                claims.claim(environmentId, readings.get(environmentId), hold !== undefined, now);
              return {
                ...(mapped === undefined ? {} : { projectId: mapped }),
                modelSelection,
                placement: {
                  environmentId,
                  label: chosen?.label ?? descriptor.label,
                  reason:
                    environmentId === scope.environmentId
                      ? reason
                      : `${reason} Project mapped to ${mapped} by repository ${keys[0]}.`,
                  mode,
                  decidedAt: now,
                  scores,
                  ...(hold === undefined ? {} : { hold }),
                },
              };
            };
            const pin = pinnedPlacement({
              here: scope.environmentId,
              namedProjectId: input.projectId,
              projectId,
              matching,
              scores,
              hereWeight: weightOf(scope.environmentId),
              settingsPin: current.agentPlacementPinnedEnvironmentId,
              atStart: current.agentPlacementAtStart,
              spill,
            });
            if (pin !== undefined) return decided(pin.environmentId, "pinned", pin.reason);
            const pinned = current.agentPlacementPinnedEnvironmentId;
            const winner = pickWinner(scores, scope.environmentId, spill);
            const queued =
              winner === undefined && byRoom && !spill
                ? Room.queuePick(
                    scores,
                    matching,
                    now,
                    current.agentPlacementMaxHoldMinutes,
                    atStart ? readings : new Map(),
                  )
                : undefined;
            if (queued !== undefined)
              return decided(queued.environmentId, "auto", queued.reason, queued.hold);
            if (winner === undefined) {
              if (claimHere)
                claims.claim(scope.environmentId, readings.get(scope.environmentId), false, now);
              return local(
                spill
                  ? "No other machine has room; holding here."
                  : "No environment is under its health line with a match; launching here.",
                scores,
                now,
              );
            }
            return decided(
              winner.environmentId,
              "auto",
              `${pinned === null ? "" : "The pinned environment is unavailable. "}${Room.winnerReason(winner)}`,
            );
          }).pipe(serial.withPermits(1));
        });
        const result = yield* evaluate.pipe(
          Effect.timeout(`${PlacementSnapshots.READ_SECONDS * 2} seconds`),
          Effect.orElseSucceed(() =>
            local("Placement data is unavailable; using the local launch path."),
          ),
        );
        yield* requireAllowed(
          input.allowed,
          result.placement.environmentId,
          result.placement.reason,
        );
        if (digest === undefined) return result;
        return yield* decisions.save(digest, now, result).pipe(
          Effect.as(keyed(result)),
          Effect.orElseSucceed(() =>
            local("Placement receipt could not be saved; using the local launch path."),
          ),
        );
      });
      return yield* digest === undefined ? decide : lock.withLock(digest, decide);
    },
  );
  const select: AgentPlacement["Service"]["select"] = Effect.fn("AgentPlacement.select")(
    function* (scope, input) {
      const selected = yield* choose(scope, input);
      if (selected !== undefined)
        yield* requireAllowed(
          input.allowed,
          selected.placement.environmentId,
          selected.placement.reason,
        );
      return selected;
    },
  );
  const run = PlacementFallback.make({
    newKey: random.uuidV4().pipe(Effect.orDie),
    label: environment.getDescriptor.pipe(Effect.map((descriptor) => descriptor.label)),
    save: (key, now, placement) => decisions.save(key, now, { placement }).pipe(Effect.ignore),
    release: claims.release,
  });
  return AgentPlacement.of({ enabled, select, run, record, read });
});

export const layer = Layer.effect(AgentPlacement, make);

export const withRecordedPlacement = Effect.fn("AgentPlacement.withRecordedPlacement")(function* <
  A extends object,
>(threadId: string | null | undefined, result: A): Effect.fn.Return<A> {
  if (threadId == null) return result;
  const service = yield* Effect.serviceOption(AgentPlacement);
  if (Option.isNone(service)) return result;
  const placement = yield* service.value.read(threadId);
  return placement === undefined ? result : { ...result, placement };
});
