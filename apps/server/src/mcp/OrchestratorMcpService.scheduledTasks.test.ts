import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

it.effect("lists every project's saved tasks on request and reports the default scope", () => {
  const caller = liveThreadShell(ThreadId.make("thread:list-schedules"), { activeRunId: null });
  const otherProjectId = ProjectId.make("project:other");
  const bound = { ...liveThreadShell(ThreadId.make("mcp:bound-task")), projectId: otherProjectId };
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:schedules"),
    requestNamespace: "provider:schedules",
    thread: {
      threadId: caller.id,
      providerSessionId: "provider:schedules",
      providerInstanceId: caller.providerInstanceId,
    },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
    client: undefined,
  };
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Scheduler.layer,
    ServerSettings.layerTest(),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(id === bound.id ? bound : caller),
      getThreadRecords: () => Effect.succeed(idleThreadProjection(caller)),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  );
  return Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService.ScheduledTaskService;
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    for (const [index, projectId] of [caller.projectId, otherProjectId, otherProjectId].entries()) {
      yield* tasks.upsert({
        id: ScheduledTaskId.make(`scheduled-task:${index}`),
        title: `Task ${index}`,
        prompt: "Review changes",
        projectId,
        threadId: index === 1 ? bound.id : null,
        enabled: index !== 2,
        schedule: { type: "interval", everyMs: 86_400_000 },
        workspaceStrategy: { type: "root" },
        modelSelection: caller.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
    }
    const all = yield* mcp.listScheduledTasks(scope, { allProjects: true });
    assert.sameMembers(
      all.tasks.map((task) => task.scheduledTaskId),
      ["scheduled-task:0", "scheduled-task:1", "scheduled-task:2"],
    );
    assert.equal(all.total, 3);
    assert.equal(all.environmentTotal, 3);
    assert.equal(all.projectId, null);
    assert.equal(all.next, null);
    const local = yield* mcp.listScheduledTasks(scope, {});
    assert.equal(local.tasks.length, 1);
    assert.equal(local.total, 1);
    assert.equal(local.environmentTotal, 3);
    assert.equal(local.projectId, caller.projectId);
    assert.equal(local.next, "All projects: call with allProjects=true.");
    const other = yield* mcp.listScheduledTasks(scope, { projectId: otherProjectId });
    assert.equal(other.total, 2);
    assert.equal(other.projectId, otherProjectId);
    assert.equal(other.tasks.filter((task) => task.enabled).length, 1);
    const client = yield* mcp.listScheduledTasks(
      {
        ...scope,
        thread: undefined,
        client: { sessionId: "owner", label: "CLI", access: "full-access" },
      },
      {},
    );
    assert.equal(client.total, 3);
    assert.equal(client.projectId, null);
    const error = yield* mcp
      .listScheduledTasks(scope, {
        allProjects: true,
        projectId: otherProjectId,
      })
      .pipe(Effect.flip);
    assert.equal(error.code, "invalid_request");
  }).pipe(
    Effect.provide(
      OrchestratorMcpService.layer.pipe(
        Layer.provideMerge(ScheduledTaskService.layer),
        Layer.provide(dependencies),
        Layer.provide(SqlitePersistence.layerMemory),
      ),
    ),
  );
});
