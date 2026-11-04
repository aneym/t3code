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
import { readCaller, unavailable } from "../mcp/threadAccess.ts";
import { callerLinkOrigin } from "../mcp/linkOrigin.ts";
import { requestPrincipal } from "../mcp/ownerCliSession.ts";

const Selection = Schema.Struct({
  placement: AgentPlacementReceipt,
  projectId: Schema.optional(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
});
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
    ) => Effect.Effect<typeof Selection.Type, OrchestratorMcpFailure>;
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
  const encode = Schema.encodeEffect(Schema.fromJsonString(Selection));
  const encodeKey = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Selection));

  const select: AgentPlacement["Service"]["select"] = Effect.fn("AgentPlacement.select")(
    function* (scope, input) {
      const caller = yield* readCaller().pipe(
        Effect.provideService(Invocation.McpInvocationContext, scope),
        Effect.provideService(Threads.ThreadManagementService, threads),
      );
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
        digest === undefined
          ? undefined
          : path.join(config.stateDir, "agent-placement", `${digest}.json`);
      const choose = Effect.gen(function* () {
        if (receiptPath !== undefined) {
          const saved = yield* fs.readFileString(receiptPath).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.void,
            ),
            Effect.mapError(unavailable),
          );
          if (saved !== undefined) return yield* decode(saved).pipe(Effect.mapError(unavailable));
        }
        const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
        const descriptor = yield* environment.getDescriptor;
        const projectId = input.projectId ?? caller.caller?.projectId;
        const modelSelection = input.modelSelection ?? caller.caller?.modelSelection;
        const local = (reason: string): typeof Selection.Type => ({
          placement: {
            environmentId: scope.environmentId,
            label: descriptor.label,
            reason,
            candidates: [],
          },
          ...(projectId === undefined ? {} : { projectId }),
          ...(modelSelection === undefined ? {} : { modelSelection }),
        });
        let result: typeof Selection.Type;
        const origin = callerLinkOrigin(caller);
        if (!current.agentLoadBalancingEnabled) result = local("Agent load balancing is off.");
        else if (
          (origin !== undefined && linkOriginIsFenced(origin)) ||
          scope.client?.linked === true
        )
          result = local("Placement was resolved by the originating environment.");
        else if (scope.client?.ownerCli === true)
          result = local("The CLI keeps its selected local workspace.");
        else if (input.localOnlyReason !== undefined) result = local(input.localOnlyReason);
        else if (projectId === undefined || modelSelection === undefined)
          result = local("No project or model to match across environments.");
        else {
          const project = yield* projects
            .getById(projectId)
            .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(unavailable));
          const key =
            project === undefined
              ? undefined
              : (yield* identities.resolve(project.workspaceRoot))?.canonicalKey;
          const localProviders = yield* providers.getProviders;
          const selectedProvider = localProviders.find(
            (provider) => provider.instanceId === modelSelection.instanceId,
          );
          const driver = input.driverKind ?? selectedProvider?.driver;
          const localResources = yield* resources.read;
          const candidates: Array<AgentPlacementReceipt["candidates"][number]> = [];
          const append = (
            id: EnvironmentId,
            label: string,
            matchedProjectId: ProjectId | null,
            snapshot: HostResourcesSnapshot | null,
            reason?: string,
          ) => {
            const weight = current.agentLoadBalancingWeights[id] ?? 50;
            const eligible = reason === undefined && matchedProjectId !== null && snapshot !== null;
            const fits =
              eligible &&
              chooseLoadBalancedEnvironment(
                [{ environmentId: id, resources: snapshot, weight, receivedAt: now }],
                now,
              ) !== null;
            const score =
              fits && snapshot !== null
                ? (weight *
                    snapshot.cpuCount *
                    (1 - (snapshot.cpuUtilization ?? 1)) *
                    snapshot.availableMemoryBytes) /
                  snapshot.totalMemoryBytes
                : null;
            candidates.push({
              environmentId: id,
              label,
              projectId: matchedProjectId,
              weight,
              score,
              resources: snapshot,
              reason:
                reason ??
                (fits
                  ? "Eligible."
                  : weight <= 0
                    ? "Manual only (weight zero)."
                    : "Insufficient CPU or memory headroom."),
            });
          };
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const localReady =
            project !== undefined &&
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
          append(
            scope.environmentId,
            descriptor.label,
            projectId,
            localResources,
            localReady ? undefined : "Project or provider unavailable.",
          );
          const linked =
            current.linkedEnvironmentsEnabled &&
            current.loadBalancingIncludeLinkedEnvironments &&
            scope.linkedEnvironments !== false
              ? yield* links.list.pipe(Effect.mapError(unavailable))
              : [];
          yield* Effect.forEach(
            linked,
            (link) =>
              Effect.gen(function* () {
                if (
                  link.access !== "full-access" ||
                  link.status !== "reachable" ||
                  (current.agentLoadBalancingWeights[link.environmentId] ?? 50) <= 0
                ) {
                  append(
                    link.environmentId,
                    link.label,
                    null,
                    null,
                    link.status !== "reachable"
                      ? "Environment is not reachable."
                      : link.access !== "full-access"
                        ? "Automatic placement requires a full-access link."
                        : "Manual only (weight zero).",
                  );
                  return;
                }
                if (project === undefined) {
                  append(
                    link.environmentId,
                    link.label,
                    null,
                    null,
                    "Source project is unavailable.",
                  );
                  return;
                }
                yield* Effect.gen(function* () {
                  const matches: Array<Project> = [];
                  let cursor: number | null = 0;
                  while (cursor !== null) {
                    const page: typeof ProjectPage.Type = yield* peers.call({
                      environmentId: link.environmentId,
                      tool: "t3_project_list",
                      arguments: { cursor, limit: 100 },
                      limits: caller.limits,
                      success: ProjectPage,
                    });
                    matches.push(
                      ...page.projects.filter((entry) =>
                        key !== undefined
                          ? entry.repositoryIdentity?.canonicalKey === key
                          : entry.workspaceRoot.split(/[\\/]/).at(-1) ===
                              project.workspaceRoot.split(/[\\/]/).at(-1) ||
                            entry.title === project.title,
                      ),
                    );
                    cursor = page.nextCursor;
                  }
                  const matched = matches.length === 1 ? matches[0] : undefined;
                  const snapshot = yield* peers.call({
                    environmentId: link.environmentId,
                    tool: "t3_environment_read",
                    arguments: matched === undefined ? {} : { projectId: matched.id },
                    limits: caller.limits,
                    success: Snapshot,
                  });
                  const provider = snapshot.placementProviders.find(
                    (entry) =>
                      entry.instanceId === modelSelection.instanceId &&
                      entry.driver === driver &&
                      entry.enabled &&
                      entry.models.includes(modelSelection.model),
                  );
                  append(
                    link.environmentId,
                    snapshot.label,
                    matched?.id ?? null,
                    snapshot.hostResources,
                    matched === undefined
                      ? "No unique project matches this repository."
                      : provider === undefined
                        ? "Selected provider or model unavailable."
                        : undefined,
                  );
                }).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.catch(() =>
                    Effect.sync(() =>
                      append(
                        link.environmentId,
                        link.label,
                        null,
                        null,
                        "Environment did not provide usable placement data.",
                      ),
                    ),
                  ),
                );
              }),
            { concurrency: 4 },
          );
          const chosen = chooseLoadBalancedEnvironment(
            candidates
              .filter((candidate) => candidate.score !== null)
              .map((candidate) => ({ ...candidate, receivedAt: now })),
            DateTime.toEpochMillis(yield* DateTime.now),
          );
          const winner = candidates.find((candidate) => candidate.environmentId === chosen);
          if (winner === undefined || winner.projectId === null)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "No eligible environment has CPU and memory headroom for this project and provider. Pass environmentId to select a machine explicitly.",
            });
          result = {
            projectId: winner.projectId,
            modelSelection,
            placement: {
              environmentId: winner.environmentId,
              label: winner.label,
              reason: `Highest weighted free CPU and memory score (${winner.score?.toFixed(2)}).`,
              candidates,
            },
          };
        }
        if (receiptPath !== undefined)
          yield* writeFileStringAtomically({
            filePath: receiptPath,
            contents: yield* encode(result).pipe(Effect.mapError(unavailable)),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HostProcess.Platform, platform),
            Effect.mapError(unavailable),
          );
        return result;
      });
      return yield* digest === undefined ? choose : lock.withLock(digest, choose);
    },
  );
  return AgentPlacement.of({ select });
});

export const layer = Layer.effect(AgentPlacement, make);
