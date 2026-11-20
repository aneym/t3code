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

import { MAX_SUBAGENT_HOPS, subagentClosure, subagentParentOf } from "./ChatSessionDescendants.ts";
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

export const setHops = (threads: ReadonlySet<ThreadId>): ReadonlyMap<ThreadId, number> =>
  new Map([...threads].map((threadId) => [threadId, 0] as const));

export function makeChatShellFilter(
  threads: ReadonlySet<ThreadId>,
  seedProjectIds: ReadonlySet<ProjectId>,
): ChatShellFilter {
  const projectIds = new Set<ProjectId>(seedProjectIds);
  let hops = new Map(setHops(threads));
  const descend = (thread: OrchestrationV2ThreadShell) => {
    if (hops.has(thread.id)) return;
    const parent = subagentParentOf(thread.lineage);
    const parentHops = parent === null ? undefined : hops.get(parent);
    if (parentHops !== undefined && parentHops < MAX_SUBAGENT_HOPS) {
      hops.set(thread.id, parentHops + 1);
    }
  };
  const keep = (thread: OrchestrationV2ThreadShell) => {
    descend(thread);
    if (!hops.has(thread.id)) return false;
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
          hops = subagentClosure(hops, [
            ...item.snapshot.threads,
            ...item.snapshot.archivedThreads,
          ]);
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
          return hops.has(item.threadId) ? item : undefined;
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

const chatProviderInstances = (
  instances: ServerSettings["providerInstances"],
): ServerSettings["providerInstances"] =>
  Object.fromEntries(
    Object.entries(instances).map(([instanceId, instance]) => {
      const customModels = (instance.config as { customModels?: unknown } | undefined)
        ?.customModels;
      return [
        instanceId,
        {
          driver: instance.driver,
          ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
          ...(instance.accentColor === undefined ? {} : { accentColor: instance.accentColor }),
          ...(instance.enabled === undefined ? {} : { enabled: instance.enabled }),
          ...(customModels === undefined ? {} : { config: { customModels } }),
        },
      ];
    }),
  );

const chatSettings = (settings: ServerSettings): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: chatProviderInstances(settings.providerInstances),
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

const withoutCatalog = (provider: ServerProvider): ServerProvider =>
  provider.slashCommands.length === 0 && provider.skills.length === 0
    ? provider
    : { ...provider, slashCommands: [], skills: [] };

const chatSnapshotEvents = (config: ServerConfig): ReadonlyArray<ServerConfigStreamEvent> => {
  const providers = config.providers.map(withoutCatalog);
  const snapshot = { version: 1, type: "snapshot", config: { ...config, providers } } as const;
  if (providers.every((provider, index) => provider === config.providers[index])) return [snapshot];
  return [
    snapshot,
    { version: 1, type: "providerStatuses", payload: { providers: config.providers } },
  ];
};

export function chatServerConfigEvents(
  event: ServerConfigStreamEvent,
  session: ChatSession,
): ReadonlyArray<ServerConfigStreamEvent> {
  switch (event.type) {
    case "snapshot":
      return chatSnapshotEvents(chatServerConfig(event.config, session));
    case "providerStatuses":
      return [
        {
          version: event.version,
          type: event.type,
          payload: { providers: event.payload.providers.map(chatProvider(session)) },
        },
      ];
    case "settingsUpdated":
      return [
        {
          version: event.version,
          type: event.type,
          payload: { settings: chatSettings(event.payload.settings) },
        },
      ];
    default:
      return [];
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
