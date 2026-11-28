import {
  OrchestratorMcpFailure,
  scoreAgentPlacement,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { isAgentHomeKey } from "../../../agents/AgentHomeOfPath.ts";
import {
  projectsByRepository,
  projectsMatchingAgentHome,
} from "../../../project/ProjectsByRepository.ts";
import * as Gate from "../../../orchestration-v2/DelegatedChildStartGate.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { isProviderAvailable, resolveProjectProviderInstanceEnabled } from "@t3tools/contracts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    agentLoadBalancingEnabled,
    agentLoadBalancingWeights,
    agentPlacementPinnedEnvironmentId,
    agentPlacementHealthLine,
    agentPlacementByRoom,
    agentPlacementAtStart,
    agentPlacementPaused,
    agentPlacementMaxHoldMinutes,
    agentPlacementSpillWhenFull,
    childStart,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    storageCleanup,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    agentLoadBalancingEnabled,
    agentLoadBalancingWeights,
    agentPlacementPinnedEnvironmentId,
    agentPlacementHealthLine,
    agentPlacementByRoom,
    agentPlacementAtStart,
    agentPlacementPaused,
    agentPlacementMaxHoldMinutes,
    agentPlacementSpillWhenFull,
    childStart,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    storageCleanup,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const resources = yield* Effect.serviceOption(HostResources.HostResources);
      const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
      let placementProjectId = input.projectId;
      let placementProjectCount: number | undefined;
      const wanted = new Set([
        ...(input.placementRepositoryKey === undefined ? [] : [input.placementRepositoryKey]),
        ...(input.placementRepositoryKeys ?? []),
      ]);
      if (
        input.placementRepositoryKey !== undefined ||
        input.placementRepositoryKeys !== undefined
      ) {
        placementProjectId = undefined;
        const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
        if (Option.isSome(projects)) {
          const isHome = [...wanted].some(isAgentHomeKey);
          const found = yield* (
            isHome
              ? projectsMatchingAgentHome(projects.value, wanted)
              : projectsByRepository(projects.value, wanted)
          ).pipe(Effect.mapError(unavailable));
          if (found.complete) placementProjectCount = found.matches.length;
          if (found.complete && found.matches.length === 1)
            placementProjectId = found.matches[0]?.id;
        }
      }
      const hostResources = Option.isSome(resources) ? yield* resources.value.read : null;
      const placementWeight = current.agentLoadBalancingWeights[descriptor.environmentId];
      const gate = yield* Effect.serviceOption(Gate.DelegatedChildStartGate);
      const placementRoom = Option.isSome(gate) ? yield* gate.value.room : undefined;
      return {
        ...(placementRoom === undefined ? {} : { placementRoom }),
        ...(placementProjectId === undefined ? {} : { placementProjectId }),
        ...(placementProjectCount === undefined ? {} : { placementProjectCount }),
        ...(placementWeight === undefined ? {} : { placementWeight }),
        placementHealthLine: current.agentPlacementHealthLine,
        placementHealth: scoreAgentPlacement({
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          resources: hostResources,
          weight: current.agentLoadBalancingWeights[descriptor.environmentId] ?? 50,
          line: current.agentPlacementHealthLine,
          now: DateTime.toEpochMillis(yield* DateTime.now),
          ...(placementRoom === undefined ? {} : { room: placementRoom }),
        }),
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        hostResources,
        ...(input.includePlacementProviders !== true
          ? {}
          : {
              placementProviders: (Option.isSome(providers)
                ? yield* providers.value.getProviders
                : []
              ).map((provider) => ({
                instanceId: provider.instanceId,
                driver: provider.driver,
                enabled:
                  isProviderAvailable(provider) &&
                  provider.enabled &&
                  provider.installed &&
                  provider.status !== "error" &&
                  provider.status !== "disabled" &&
                  provider.auth.status !== "unauthenticated" &&
                  resolveProjectProviderInstanceEnabled(
                    current,
                    placementProjectId ?? null,
                    provider.instanceId,
                  ),
                models: provider.models.map((model) => model.slug),
              })),
            }),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
