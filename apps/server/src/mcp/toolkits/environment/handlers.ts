import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { isProviderAvailable, resolveProjectProviderInstanceEnabled } from "@t3tools/contracts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ServerDrain from "../../../orchestration-v2/ServerDrain.ts";
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
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    agentLoadBalancingEnabled,
    agentLoadBalancingWeights,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
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
      if (input.placementRepositoryKey !== undefined) {
        placementProjectId = undefined;
        const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
        if (Option.isSome(projects)) {
          const matches = [];
          let cursor: number | null = 0;
          let pages = 0;
          while (cursor !== null && pages++ < 10) {
            const page: Effect.Success<
              ReturnType<ProjectService.ProjectService["Service"]["listPage"]>
            > = yield* projects.value
              .listPage({ cursor, limit: 100 })
              .pipe(Effect.mapError(unavailable));
            matches.push(
              ...page.projects.filter(
                (project) =>
                  project.repositoryIdentity?.canonicalKey === input.placementRepositoryKey,
              ),
            );
            cursor = page.nextCursor;
          }
          if (cursor === null && matches.length === 1) placementProjectId = matches[0]?.id;
        }
      }
      return {
        ...(placementProjectId === undefined ? {} : { placementProjectId }),
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        hostResources: Option.isSome(resources) ? yield* resources.value.read : null,
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
  t3_server_drain: McpToolAccess.reads(({ action, timeoutMs }) =>
    Effect.gen(function* () {
      const { scope } = yield* access;
      if (scope.client?.ownerCli !== true)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Server drain is only for the owner's t3 CLI on this machine.",
        });
      const drain = yield* ServerDrain.ServerDrain;
      const result =
        action === "status"
          ? drain.status
          : action === "wait"
            ? drain.wait(timeoutMs ?? 30_000)
            : drain.set(action === "on");
      return yield* result.pipe(Effect.mapError(unavailable));
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
