import {
  AgentPlacementReceipt,
  chooseLoadBalancedEnvironment,
  AgentPlacementProviders,
  EnvironmentId,
  HostResourcesSnapshot,
  ModelSelection,
  OrchestratorMcpFailure,
  Project,
  ProjectId,
  type ProviderDriverKind,
  isProviderAvailable,
  linkOriginIsFenced,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Resources from "../resourceTelemetry/HostResources.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Peers from "./PeerMcpClient.ts";
import * as Links from "./PeerLinks.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { assertLiveCaller, readCaller, unavailable } from "../mcp/threadAccess.ts";
import { callerLinkOrigin } from "../mcp/linkOrigin.ts";
import { requestPrincipal } from "../mcp/ownerCliSession.ts";

const Selection = Schema.Struct({
  placement: AgentPlacementReceipt,
  projectId: Schema.optional(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
});
const SavedSelection = Schema.Struct({ savedAt: Schema.Number, selection: Selection });
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const Snapshot = Schema.Struct({
  label: Schema.String,
  hostResources: HostResourcesSnapshot,
  placementProviders: AgentPlacementProviders,
});
const ProjectPage = Schema.Struct({
  projects: Schema.Array(Project),
  nextCursor: Schema.NullOr(Schema.Number),
});

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
    ) => Effect.Effect<typeof Selection.Type | undefined, OrchestratorMcpFailure>;
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* Threads.ThreadManagementService;
  const platform = yield* HostProcess.Platform;
  const lock = yield* KeyedLock.make<string>();
  const encode = Schema.encodeEffect(Schema.fromJsonString(SavedSelection));
  const encodeKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(SavedSelection));
  const receiptDir = path.join(config.stateDir, "agent-placement");
  let lastPrunedAt = 0;
  const prune = Effect.fn("AgentPlacement.prune")(function* (now: number) {
    if (now - lastPrunedAt < 5 * 60 * 1000) return;
    lastPrunedAt = now;
    const files = yield* fs.readDirectory(receiptDir);
    yield* Effect.forEach(
      files.filter((file) => /^[a-f0-9]+\.json$/.test(file)),
      (file) =>
        Effect.gen(function* () {
          const filePath = path.join(receiptDir, file);
          const stat = yield* fs.stat(filePath);
          if (Option.isNone(stat.mtime) || now - stat.mtime.value.getTime() > RECEIPT_MAX_AGE_MS)
            yield* fs.remove(filePath);
        }).pipe(Effect.ignore),
      { concurrency: 4 },
    );
  });
  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.agentLoadBalancingEnabled),
    Effect.orElseSucceed(() => false),
  );

  const select: AgentPlacement["Service"]["select"] = Effect.fn("AgentPlacement.select")(
    function* (scope, input) {
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      if (!current.agentLoadBalancingEnabled) return undefined;
      const caller = yield* readCaller().pipe(
        Effect.provideService(Invocation.McpInvocationContext, scope),
        Effect.provideService(Threads.ThreadManagementService, threads),
      );
      const descriptor = yield* environment.getDescriptor;
      const projectId = input.projectId ?? caller.caller?.projectId;
      const modelSelection = input.modelSelection ?? caller.caller?.modelSelection;
      const local = (reason: string): typeof Selection.Type => ({
        placement: { environmentId: scope.environmentId, label: descriptor.label, reason },
        ...(projectId === undefined ? {} : { projectId }),
        ...(modelSelection === undefined ? {} : { modelSelection }),
      });
      const origin = callerLinkOrigin(caller);
      if ((origin !== undefined && linkOriginIsFenced(origin)) || scope.client?.linked === true)
        return local("Placement was resolved by the originating environment.");
      if (scope.client?.ownerCli === true)
        return local("The CLI keeps its selected local workspace.");
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
          : Hex.encode(
              yield* crypto
                .digest(
                  "SHA-256",
                  new TextEncoder().encode(
                    yield* encodeKey([
                      requestPrincipal(scope),
                      input.operation,
                      input.clientRequestId,
                    ]).pipe(Effect.mapError(unavailable)),
                  ),
                )
                .pipe(Effect.mapError(unavailable)),
            );
      const receiptPath =
        digest === undefined ? undefined : path.join(receiptDir, `${digest}.json`);
      const choose = Effect.gen(function* () {
        if (!(yield* enabled)) return undefined;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        yield* prune(now).pipe(Effect.ignore);
        if (receiptPath !== undefined) {
          const saved = yield* fs.readFileString(receiptPath).pipe(
            Effect.flatMap(decode),
            Effect.orElseSucceed(() => undefined),
          );
          if (
            saved !== undefined &&
            saved.savedAt <= now &&
            now - saved.savedAt <= RECEIPT_MAX_AGE_MS
          )
            return saved.selection;
        }
        const evaluate = Effect.gen(function* () {
          const project = yield* projects
            .getById(projectId)
            .pipe(Effect.map(Option.getOrUndefined));
          const key =
            project === undefined
              ? undefined
              : (yield* identities.resolve(project.workspaceRoot))?.canonicalKey;
          if (key === undefined)
            return local("No repository identity to match across environments.");
          const localProviders = yield* providers.getProviders;
          const selectedProvider = localProviders.find(
            (provider) => provider.instanceId === modelSelection.instanceId,
          );
          const driver = input.driverKind ?? selectedProvider?.driver;
          const candidates: Array<{
            environmentId: EnvironmentId;
            label: string;
            projectId: ProjectId;
            resources: HostResourcesSnapshot;
            weight: number;
            receivedAt: number;
          }> = [];
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
          const localResources = yield* resources.read;
          if (localReady && localResources !== null)
            candidates.push({
              environmentId: scope.environmentId,
              label: descriptor.label,
              projectId,
              resources: localResources,
              weight: current.agentLoadBalancingWeights[scope.environmentId] ?? 50,
              receivedAt: now,
            });
          if (
            current.linkedEnvironmentsEnabled &&
            current.loadBalancingIncludeLinkedEnvironments &&
            scope.linkedEnvironments !== false
          ) {
            yield* Effect.gen(function* () {
              const linked = yield* links.list;
              yield* Effect.forEach(
                linked.filter(
                  (link) =>
                    link.access === "full-access" &&
                    link.status === "reachable" &&
                    (current.agentLoadBalancingWeights[link.environmentId] ?? 50) > 0,
                ),
                (link) =>
                  Effect.gen(function* () {
                    const matches: Array<Project> = [];
                    let cursor: number | null = 0;
                    let pages = 0;
                    while (cursor !== null && pages++ < 10) {
                      const page: typeof ProjectPage.Type = yield* peers.call({
                        environmentId: link.environmentId,
                        tool: "t3_project_list",
                        arguments: { cursor, limit: 100 },
                        limits: caller.limits,
                        success: ProjectPage,
                      });
                      matches.push(
                        ...page.projects.filter(
                          (entry) => entry.repositoryIdentity?.canonicalKey === key,
                        ),
                      );
                      cursor = page.nextCursor;
                    }
                    const matched =
                      cursor === null && matches.length === 1 ? matches[0] : undefined;
                    if (matched === undefined) return;
                    const snapshot = yield* peers.call({
                      environmentId: link.environmentId,
                      tool: "t3_environment_read",
                      arguments: { projectId: matched.id, includePlacementProviders: true },
                      limits: caller.limits,
                      success: Snapshot,
                    });
                    if (
                      !snapshot.placementProviders.some(
                        (entry) =>
                          entry.instanceId === modelSelection.instanceId &&
                          entry.driver === driver &&
                          entry.enabled &&
                          entry.models.includes(modelSelection.model),
                      )
                    )
                      return;
                    candidates.push({
                      environmentId: link.environmentId,
                      label: snapshot.label,
                      projectId: matched.id,
                      resources: snapshot.hostResources,
                      weight: current.agentLoadBalancingWeights[link.environmentId] ?? 50,
                      receivedAt: now,
                    });
                  }).pipe(Effect.timeout("1 second"), Effect.ignore),
                { concurrency: 4 },
              );
            }).pipe(Effect.timeout("2 seconds"), Effect.ignore);
          }
          const chosen = chooseLoadBalancedEnvironment(
            candidates,
            DateTime.toEpochMillis(yield* DateTime.now),
          );
          const winner = candidates.find((candidate) => candidate.environmentId === chosen);
          if (winner === undefined)
            return local("No eligible placement data; using the local launch path.");
          const score =
            (winner.weight *
              winner.resources.cpuCount *
              (1 - (winner.resources.cpuUtilization ?? 1)) *
              winner.resources.availableMemoryBytes) /
            winner.resources.totalMemoryBytes;
          return {
            projectId: winner.projectId,
            modelSelection,
            placement: {
              environmentId: winner.environmentId,
              label: winner.label,
              reason: `Highest weighted free CPU and memory score (${score.toFixed(2)}).`,
            },
          };
        });
        const result = yield* evaluate.pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed(() =>
            local("Placement data is unavailable; using the local launch path."),
          ),
        );
        if (receiptPath === undefined) return result;
        return yield* writeFileStringAtomically({
          filePath: receiptPath,
          contents: yield* encode({ savedAt: now, selection: result }).pipe(
            Effect.mapError(unavailable),
          ),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.as(result),
          Effect.orElseSucceed(() =>
            local("Placement receipt could not be saved; using the local launch path."),
          ),
        );
      });
      return yield* digest === undefined ? choose : lock.withLock(digest, choose);
    },
  );
  return AgentPlacement.of({ enabled, select });
});

export const layer = Layer.effect(AgentPlacement, make);
