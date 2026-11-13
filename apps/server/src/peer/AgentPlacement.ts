import {
  AgentPlacementReceipt,
  type AgentPlacementScore,
  EnvironmentId,
  ModelSelection,
  OrchestratorMcpFailure,
  ProjectId,
  type ProviderDriverKind,
  isProviderAvailable,
  linkOriginIsFenced,
  resolveProjectProviderInstanceEnabled,
  scoreAgentPlacement,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import { repositoryIdentityKeys } from "../project/RepositoryIdentityKeys.ts";
import * as Resources from "../resourceTelemetry/HostResources.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Peers from "./PeerMcpClient.ts";
import * as Links from "./PeerLinks.ts";
import * as PlacementSnapshots from "./PlacementSnapshots.ts";
import * as PlacementDecisions from "./PlacementDecisions.ts";
import * as PlacementWeights from "./PlacementWeights.ts";
import * as PlacementFallback from "./PlacementFallback.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { assertLiveCaller, readCaller, unavailable } from "../mcp/threadAccess.ts";
import { callerLinkOrigin } from "../mcp/linkOrigin.ts";
import { requestPrincipal } from "../mcp/ownerCliSession.ts";

export type Selected = PlacementFallback.Selected;
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentPlacementReceipt));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(AgentPlacementReceipt));

export class AgentPlacement extends Context.Service<
  AgentPlacement,
  {
    readonly enabled: Effect.Effect<boolean>;
    readonly select: (
      scope: Invocation.McpInvocationScope,
      input: {
        readonly operation: "launch" | "delegate";
        readonly projectId?: ProjectId | undefined;
        readonly modelSelection?: ModelSelection | undefined;
        readonly driverKind?: ProviderDriverKind | undefined;
        readonly clientRequestId?: string | undefined;
        readonly localOnlyReason?: string | undefined;
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
  const digests = yield* Digest.Digest;
  const threads = yield* Threads.ThreadManagementService;
  const lock = yield* KeyedLock.make<string>();
  const random = yield* SecureRandom.SecureRandom;
  const encodeModel = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* PlacementSnapshots.make(peers);
  const encodeKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
  const decisions = yield* PlacementDecisions.make(config.stateDir);
  const enabled = settings.getSettings.pipe(
    Effect.map(
      (current) =>
        current.agentLoadBalancingEnabled &&
        current.linkedEnvironmentsEnabled &&
        current.loadBalancingIncludeLinkedEnvironments,
    ),
    Effect.orElseSucceed(() => false),
  );

  const select: AgentPlacement["Service"]["select"] = Effect.fn("AgentPlacement.select")(
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
      const projectId = input.projectId ?? caller.caller?.projectId;
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
      if (input.localOnlyReason !== undefined) return local(input.localOnlyReason);
      if (projectId === undefined || modelSelection === undefined)
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
          : yield* digests.digestHex(
              Digest.sha256,
              new TextEncoder().encode(
                yield* encodeKey([
                  requestPrincipal(scope),
                  input.operation,
                  input.clientRequestId,
                  projectId,
                  yield* encodeModel(modelSelection).pipe(Effect.mapError(unavailable)),
                  input.driverKind ?? "",
                ]).pipe(Effect.mapError(unavailable)),
              ),
            );
      const keyed = (selection: PlacementDecisions.Selection): Selected =>
        digest === undefined ? selection : { ...selection, decisionKey: digest };
      const choose = Effect.gen(function* () {
        if (!(yield* enabled)) return undefined;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (digest !== undefined) {
          const saved = yield* decisions.load(digest, now);
          if (saved !== undefined) return keyed(saved);
        }
        const evaluate = Effect.gen(function* () {
          const project = yield* projects
            .getById(projectId)
            .pipe(Effect.map(Option.getOrUndefined));
          const keys = repositoryIdentityKeys(
            project === undefined ? undefined : yield* identities.resolve(project.workspaceRoot),
          );
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
          const scores: Array<AgentPlacementScore> = [];
          const matching = new Map<EnvironmentId, ProjectId>();
          const localReady =
            selectedProvider !== undefined &&
            isProviderAvailable(selectedProvider) &&
            selectedProvider.enabled &&
            selectedProvider.installed &&
            selectedProvider.status !== "error" &&
            selectedProvider.status !== "disabled" &&
            selectedProvider.auth.status !== "unauthenticated" &&
            resolveProjectProviderInstanceEnabled(
              current,
              projectId,
              selectedProvider.instanceId,
            ) &&
            selectedProvider.models.some((model) => model.slug === modelSelection.model);
          const localScore = scoreAgentPlacement({
            environmentId: scope.environmentId,
            label: descriptor.label,
            resources: yield* resources.read,
            weight: weightOf(scope.environmentId),
            line,
            now,
          });
          if (localReady) matching.set(scope.environmentId, projectId);
          scores.push(
            localReady
              ? localScore
              : { ...localScore, score: 0, skipped: "Provider or model unavailable here." },
          );
          if (
            current.linkedEnvironmentsEnabled &&
            current.loadBalancingIncludeLinkedEnvironments &&
            scope.linkedEnvironments !== false
          ) {
            yield* Effect.gen(function* () {
              const linked = (yield* links.stored).filter(
                (link) =>
                  link.access === "full-access" && DateTime.toEpochMillis(link.expiresAt) > now,
              );
              yield* snapshots.refresh({
                environmentIds: linked
                  .filter((link) => weightOf(link.environmentId) > 0)
                  .map((link) => link.environmentId),
                keys,
                limits: caller.limits,
                now,
              });
              const scoredAt = DateTime.toEpochMillis(yield* DateTime.now);
              for (const link of linked) {
                const entry = snapshots.cached(link.environmentId, keys, now);
                const snapshot = entry?.value;
                const sources = {
                  callerEntry: current.agentLoadBalancingWeights[link.environmentId],
                  own: snapshot?.placementWeight,
                  label: snapshot?.label ?? link.label,
                };
                const scored = scoreAgentPlacement({
                  environmentId: link.environmentId,
                  label: sources.label,
                  resources: snapshot?.hostResources,
                  weight: PlacementWeights.linkedWeight(sources),
                  line: snapshot?.placementHealthLine ?? line,
                  now: scoredAt,
                });
                const skipped =
                  scored.skipped === "Weight is 0."
                    ? scored.skipped
                    : snapshot === undefined
                      ? (entry?.failure ?? `No reply within ${PlacementSnapshots.READ_SECONDS} s.`)
                      : snapshot.placementProjectId === undefined
                        ? (snapshot.placementProjectCount ?? 0) > 1
                          ? `${snapshot.placementProjectCount} projects there match the repository; name the environment and project to use one.`
                          : "The project is not registered there."
                        : !snapshot.placementProviders?.some(
                              (entry) =>
                                entry.instanceId === modelSelection.instanceId &&
                                entry.driver === driver &&
                                entry.enabled &&
                                entry.models.includes(modelSelection.model),
                            )
                          ? "Provider or model unavailable there."
                          : undefined;
                if (skipped === undefined && snapshot?.placementProjectId !== undefined)
                  matching.set(link.environmentId, snapshot.placementProjectId);
                scores.push(
                  PlacementWeights.explainWeight(
                    skipped === undefined ? scored : { ...scored, score: 0, skipped },
                    sources,
                  ),
                );
              }
            }).pipe(
              Effect.timeout(`${PlacementSnapshots.READ_SECONDS + 2} seconds`),
              Effect.ignore,
            );
          }
          const decided = (
            environmentId: EnvironmentId,
            mode: "auto" | "pinned",
            reason: string,
          ): PlacementDecisions.Selection => {
            const chosen = scores.find((entry) => entry.environmentId === environmentId);
            const mapped = matching.get(environmentId) ?? projectId;
            return {
              projectId: mapped,
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
              },
            };
          };
          const pinned = current.agentPlacementPinnedEnvironmentId;
          if (pinned !== null && matching.has(pinned))
            return decided(pinned, "pinned", "Pinned to this environment in settings.");
          const winner = scores
            .filter((entry) => entry.skipped === undefined && entry.score > 0)
            .toSorted((left, right) => right.score - left.score)[0];
          if (winner === undefined)
            return local(
              "No environment is under its health line with a match; launching here.",
              scores,
              now,
            );
          return decided(
            winner.environmentId,
            "auto",
            `${pinned === null ? "" : "The pinned environment is unavailable. "}Most weighted headroom (${winner.score.toFixed(2)}).`,
          );
        });
        const result = yield* evaluate.pipe(
          Effect.timeout(`${PlacementSnapshots.READ_SECONDS * 2} seconds`),
          Effect.orElseSucceed(() =>
            local("Placement data is unavailable; using the local launch path."),
          ),
        );
        if (digest === undefined) return result;
        return yield* decisions.save(digest, now, result).pipe(
          Effect.as(keyed(result)),
          Effect.orElseSucceed(() =>
            local("Placement receipt could not be saved; using the local launch path."),
          ),
        );
      });
      return yield* digest === undefined ? choose : lock.withLock(digest, choose);
    },
  );
  const record: AgentPlacement["Service"]["record"] = Effect.fn("AgentPlacement.record")(
    function* (threadId, placement) {
      if (placement === undefined) return;
      const json = yield* encodeReceipt(placement);
      const recordedAt = placement.decidedAt ?? DateTime.toEpochMillis(yield* DateTime.now);
      yield* sql`INSERT INTO aneym_thread_placements (thread_id, placement_json, recorded_at)
        VALUES (${threadId}, ${json}, ${recordedAt})
        ON CONFLICT(thread_id) DO UPDATE SET placement_json = excluded.placement_json,
          recorded_at = excluded.recorded_at`;
    },
    Effect.ignore({ log: true }),
  );
  const read: AgentPlacement["Service"]["read"] = Effect.fn("AgentPlacement.read")(
    function* (threadId) {
      const rows = yield* sql<{ readonly placement_json: string }>`
        SELECT placement_json FROM aneym_thread_placements WHERE thread_id = ${threadId}`;
      const row = rows[0];
      return row === undefined ? undefined : yield* decodeReceipt(row.placement_json);
    },
    Effect.orElseSucceed(() => undefined),
  );
  const fellBack = Effect.fn("AgentPlacement.fellBack")(function* (
    scope: Invocation.McpInvocationScope,
    selected: Selected,
    answer: string,
  ) {
    const descriptor = yield* environment.getDescriptor;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const chosen = selected.placement;
    const placement: AgentPlacementReceipt = {
      environmentId: scope.environmentId,
      label: descriptor.label,
      reason: `${chosen.label} was chosen (${chosen.reason}) and answered: ${answer} Started here instead.`,
      mode: "local",
      decidedAt: now,
      ...(chosen.scores === undefined ? {} : { scores: chosen.scores }),
    };
    if (selected.decisionKey !== undefined)
      yield* decisions.save(selected.decisionKey, now, { placement }).pipe(Effect.ignore);
    return placement;
  });
  const run = PlacementFallback.make({ newKey: random.uuidV4().pipe(Effect.orDie), fellBack });
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
