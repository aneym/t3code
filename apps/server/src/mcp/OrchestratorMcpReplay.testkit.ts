import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderReplayEntry,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "./McpHttpServer.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const queuedFollowupResult = "Queued delegated follow-up completed.";

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(function* (
  followupResult: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(
    decodeURIComponent(delegatedTaskStatusTranscriptFile.pathname),
  );
  const transcript = yield* decodeProviderReplayNdjson(
    text.replaceAll(queuedFollowupResult, followupResult),
  );
  const parentActive = transcript.entries.find(
    (entry) => entry.type === "emit_inbound" && entry.label === "parent.thread/status/changed",
  );
  if (parentActive?.type !== "emit_inbound") throw new Error("Parent active frame is missing.");
  return {
    ...transcript,
    entries: transcript.entries.flatMap<ProviderReplayEntry>((entry) =>
      entry.type === "runtime_exit"
        ? [{ ...parentActive, label: "parent.waiting-for-mcp" }, entry]
        : [entry],
    ),
  };
}, Effect.provide(NodeServices.layer));

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("ScheduledTaskService.upsert is unused in this test"),
    setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
    delete: () => Effect.die("ScheduledTaskService.delete is unused in this test"),
    deleteForThread: () => Effect.die("unused in this test"),
    runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
    rotateWebhookToken: () => Effect.die("unused in this test"),
    listWebhookDeliveries: () => Effect.die("unused in this test"),
    getWebhookDelivery: () => Effect.die("unused in this test"),
    triggerWebhook: () => Effect.die("unused in this test"),
  }),
);

export const makeOrchestratorMcpReplayFixture = Effect.fn("makeOrchestratorMcpReplayFixture")(
  function* (input: {
    readonly followupResult: string;
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  }) {
    const cwd = yield* checkpointWorkspace("delegated-task-status");
    const rawTranscript = yield* readDelegatedTaskStatusTranscript(input.followupResult);
    const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
      materializeReplayTranscriptWorkspace(rawTranscript, cwd),
    );
    const replayGate = makeProviderReplayGate(["parent.waiting-for-mcp"]);
    const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
      {
        name: "delegated-task-status/codex",
        transcript,
        commands: [],
        runtimePolicyOverride: { cwd },
      },
      CodexOrchestratorReplayHarness,
      { replayGate },
    );
    const layerOrchestration = Layer.merge(
      layerOrchestrator,
      ThreadManagementService.layer.pipe(
        Layer.provide(layerOrchestrator),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
      ),
    );
    const layerProviderRegistry = ProviderRegistryMock.layer([
      makeProviderSnapshot({
        instanceId: input.instanceId,
        driver: ProviderDriverKind.make("codex"),
        model: input.model,
      }),
    ]);
    const layerTest = layerOrchestratorToolkit.pipe(
      Layer.provideMerge(layerOrchestration),
      Layer.provide(
        CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript, {
          replayGate,
        }).pipe(Layer.provide(McpProviderSessions.layer)),
      ),
      Layer.provide(layerProviderRegistry),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerUnusedScheduledTaskStub),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provideMerge(
        SecretRequests.layer.pipe(
          Layer.provide(layerMemorySecretStore),
          Layer.provide(layerOrchestration),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );

    return { cwd, layerTest };
  },
);
