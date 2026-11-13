import {
  AgentPlacementHealthLine,
  AgentPlacementProviders,
  AgentPlacementScore,
  ProjectId,
  HostResourcesSnapshot,
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  agentLoadBalancingEnabled: ServerSettings.fields.agentLoadBalancingEnabled,
  agentLoadBalancingWeights: ServerSettings.fields.agentLoadBalancingWeights,
  agentPlacementPinnedEnvironmentId: ServerSettings.fields.agentPlacementPinnedEnvironmentId,
  agentPlacementHealthLine: ServerSettings.fields.agentPlacementHealthLine,
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    projectId: Schema.optionalKey(ProjectId),
    placementRepositoryKey: Schema.optionalKey(Schema.String),
    placementRepositoryKeys: Schema.optionalKey(Schema.Array(Schema.String)),
    includePlacementProviders: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
    hostResources: Schema.optionalKey(Schema.NullOr(HostResourcesSnapshot)),
    placementProjectId: Schema.optionalKey(ProjectId),
    placementProjectCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    placementWeight: Schema.optionalKey(Schema.Finite),
    placementProviders: Schema.optionalKey(AgentPlacementProviders),
    placementHealthLine: Schema.optionalKey(AgentPlacementHealthLine),
    placementHealth: Schema.optionalKey(AgentPlacementScore),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    agentLoadBalancingEnabled: ServerSettingsPatch.fields.agentLoadBalancingEnabled,
    agentLoadBalancingWeights: ServerSettingsPatch.fields.agentLoadBalancingWeights,
    agentPlacementPinnedEnvironmentId: ServerSettingsPatch.fields.agentPlacementPinnedEnvironmentId,
    agentPlacementHealthLine: ServerSettingsPatch.fields.agentPlacementHealthLine,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(EnvironmentReadTool, EnvironmentPreferencesTool);
