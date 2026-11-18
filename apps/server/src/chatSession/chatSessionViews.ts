import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";

import type { ChatSession } from "./ChatThreadSets.ts";

const PLACEHOLDER_PATH = "/";

const chatProject = (project: OrchestrationProjectShell): OrchestrationProjectShell => ({
  id: project.id,
  title: project.title,
  workspaceRoot: PLACEHOLDER_PATH,
  defaultModelSelection: null,
  scripts: [],
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

export interface ChatShellFilter {
  readonly apply: (
    item: OrchestrationV2ShellStreamItem,
  ) => OrchestrationV2ShellStreamItem | undefined;
}

export function makeChatShellFilter(
  threads: ReadonlySet<ThreadId>,
  seedProjectIds: ReadonlySet<ProjectId>,
): ChatShellFilter {
  const projectIds = new Set<ProjectId>(seedProjectIds);
  const keep = (thread: OrchestrationV2ThreadShell) => {
    if (!threads.has(thread.id)) return false;
    projectIds.add(thread.projectId);
    return true;
  };
  return {
    apply: (item) => {
      switch (item.kind) {
        case "synchronized":
        case "snapshot-required":
          return item;
        case "snapshot": {
          const active = item.snapshot.threads.filter(keep);
          const archived = item.snapshot.archivedThreads.filter(keep);
          return {
            kind: "snapshot",
            snapshot: {
              schemaVersion: item.snapshot.schemaVersion,
              snapshotSequence: item.snapshot.snapshotSequence,
              threads: active,
              archivedThreads: archived,
              projects: item.snapshot.projects
                .filter((project) => projectIds.has(project.id))
                .map(chatProject),
            },
            ...(item.resolvedRepositoryIdentityRoots === undefined
              ? {}
              : { resolvedRepositoryIdentityRoots: [] }),
          };
        }
        case "project.updated":
          return projectIds.has(item.project.id)
            ? { kind: item.kind, sequence: item.sequence, project: chatProject(item.project) }
            : undefined;
        case "project.removed":
          return projectIds.has(item.projectId) ? item : undefined;
        case "thread.updated":
          return keep(item.thread) ? item : undefined;
        case "thread.removed":
          return threads.has(item.threadId) ? item : undefined;
      }
    },
  };
}

const chatProvider =
  (session: ChatSession) =>
  (provider: ServerProvider): ServerProvider => ({
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    enabled: provider.enabled,
    installed: provider.installed,
    version: null,
    status: provider.status,
    auth: { status: provider.auth.status },
    checkedAt: provider.checkedAt,
    models: provider.models,
    slashCommands: session.ownerThreads.size > 0 ? provider.slashCommands : [],
    skills: session.ownerThreads.size > 0 ? provider.skills : [],
  });

const chatSettings = (settings: ServerSettings): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  embedModeEnabled: settings.embedModeEnabled,
  embedAllowedOrigins: settings.embedAllowedOrigins,
  responseStreamingMode: settings.responseStreamingMode,
  quietThreadNotes: settings.quietThreadNotes,
  promptSuggestionsEnabled: settings.promptSuggestionsEnabled,
  defaultTheme: settings.defaultTheme,
  defaultThemeSetAt: settings.defaultThemeSetAt,
  environmentIcon: settings.environmentIcon,
});

export const chatServerConfig = (config: ServerConfig, session: ChatSession): ServerConfig => ({
  environment: config.environment,
  auth: config.auth,
  cwd: PLACEHOLDER_PATH,
  keybindingsConfigPath: PLACEHOLDER_PATH,
  keybindings: [],
  issues: [],
  providers: config.providers.map(chatProvider(session)),
  availableEditors: [],
  observability: {
    logsDirectoryPath: PLACEHOLDER_PATH,
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: chatSettings(config.settings),
  chatSession: { ownerThreadIds: [...session.ownerThreads], threadIds: [...session.threads] },
});

export function chatServerConfigEvent(
  event: ServerConfigStreamEvent,
  session: ChatSession,
): ServerConfigStreamEvent | undefined {
  switch (event.type) {
    case "snapshot":
      return {
        version: event.version,
        type: event.type,
        config: chatServerConfig(event.config, session),
      };
    case "providerStatuses":
      return {
        version: event.version,
        type: event.type,
        payload: { providers: event.payload.providers.map(chatProvider(session)) },
      };
    case "settingsUpdated":
      return {
        version: event.version,
        type: event.type,
        payload: { settings: chatSettings(event.payload.settings) },
      };
    default:
      return undefined;
  }
}

export const chatLifecycleEvent = (
  event: ServerLifecycleStreamEvent,
): ServerLifecycleStreamEvent | undefined =>
  event.type === "ready"
    ? {
        version: event.version,
        sequence: event.sequence,
        type: event.type,
        payload: { at: event.payload.at, environment: event.payload.environment },
      }
    : undefined;
