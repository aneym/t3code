import * as Layer from "effect/Layer";

import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { registerDeviceScreenshot, registerHtmlPreview } from "./mcpServer/imageTools.ts";
import { registerPreviewSnapshot } from "./mcpServer/previewSnapshotTool.ts";
import { layerMcpTransport } from "./mcpServer/transport.ts";
import * as ThreadConfiguration from "./ThreadConfigurationService.ts";
import { imageToolRegistration, toolkitRegistration } from "./mcpServer/toolkitRegistration.ts";
import { AgentToolkit } from "./toolkits/agent/tools.ts";
import * as AgentHandlers from "./toolkits/agent/handlers.ts";
import { McpEventsToolkit } from "./toolkits/mcpEvents/tools.ts";
import * as McpEventsHandlers from "./toolkits/mcpEvents/handlers.ts";
import * as HostLinkHandlers from "./toolkits/hostLink/handlers.ts";
import { HostLinkToolkit } from "./toolkits/hostLink/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import * as PreviewControlsHandlers from "./toolkits/previewControls/handlers.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import * as EnvironmentHandlers from "./toolkits/environment/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import * as AttachmentHandlers from "./toolkits/attachment/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import { PreviewStandardToolkit } from "./toolkits/preview/tools.ts";
import * as WorktreeHandlers from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as PullRequestsHandlers from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import * as DeviceHandlers from "./toolkits/device/handlers.ts";
import { DeviceStandardToolkit } from "./toolkits/device/tools.ts";
import * as HtmlHandlers from "./toolkits/html/handlers.ts";
import { HtmlRenderToolkit } from "./toolkits/html/tools.ts";

export const layerHtmlToolkit = Layer.mergeAll(
  toolkitRegistration(HtmlRenderToolkit, HtmlHandlers.layerRender),
  imageToolRegistration(registerHtmlPreview(), HtmlHandlers.layerPreview),
).pipe(Layer.provide(HtmlRender.layer));

const layerPreviewStandardToolkitRegistration = toolkitRegistration(
  PreviewStandardToolkit,
  PreviewHandlers.layerStandard,
);

const layerPreviewSnapshotRegistration = imageToolRegistration(
  registerPreviewSnapshot(),
  PreviewHandlers.layerSnapshot,
);

export const layerPreviewToolkit = Layer.mergeAll(
  layerPreviewStandardToolkitRegistration,
  layerPreviewSnapshotRegistration,
);

export const layerOrchestratorToolkit = toolkitRegistration(
  OrchestratorToolkit,
  OrchestratorHandlers.layer,
).pipe(Layer.provide(ThreadConfiguration.toolkitLayer));

export const layerThreadToolkit = toolkitRegistration(ThreadToolkit, ThreadHandlers.layer).pipe(
  Layer.provide(ThreadConfiguration.layer),
);

const layerWorktreeToolkitRegistration = toolkitRegistration(
  WorktreeToolkit,
  WorktreeHandlers.layer,
).pipe(Layer.provide(WorktreeHandlers.layerServices));

const layerPreviewControlsRegistration = toolkitRegistration(
  PreviewControlsToolkit,
  PreviewControlsHandlers.layer,
);

const layerEnvironmentToolkit = toolkitRegistration(
  EnvironmentToolkit,
  EnvironmentHandlers.layer,
).pipe(Layer.provide(ThreadCommandExecutor.layer));

export const layerProjectRegistration = toolkitRegistration(ProjectToolkit, ProjectHandlers.layer);

export const layerAttachmentToolkit = toolkitRegistration(
  AttachmentToolkit,
  AttachmentHandlers.layer,
);

export const layerPullRequestsToolkit = toolkitRegistration(
  PullRequestsToolkit,
  PullRequestsHandlers.layer,
);

const layerDeviceStandardToolkitRegistration = toolkitRegistration(
  DeviceStandardToolkit,
  DeviceHandlers.layerStandard,
);

const layerDeviceScreenshotRegistration = imageToolRegistration(
  registerDeviceScreenshot(),
  DeviceHandlers.layerScreenshot,
);

export const layerDeviceToolkit = Layer.mergeAll(
  layerDeviceStandardToolkitRegistration,
  layerDeviceScreenshotRegistration,
);

export const layerTools = Layer.mergeAll(
  layerPreviewToolkit,
  layerOrchestratorToolkit,
  layerThreadToolkit.pipe(Layer.provide(ThreadConfiguration.toolkitLayer)),
  toolkitRegistration(AgentToolkit, AgentHandlers.layer),
  toolkitRegistration(McpEventsToolkit, McpEventsHandlers.layer),
  toolkitRegistration(HostLinkToolkit, HostLinkHandlers.layer),
  layerAttachmentToolkit,
  layerProjectRegistration,
  layerEnvironmentToolkit,
  layerPreviewControlsRegistration,
  layerWorktreeToolkitRegistration,
  layerPullRequestsToolkit,
  layerDeviceToolkit,
  layerHtmlToolkit,
);

export const layer = layerTools.pipe(Layer.provideMerge(layerMcpTransport));
