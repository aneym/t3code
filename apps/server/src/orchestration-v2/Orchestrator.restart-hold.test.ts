import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for queue holds"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "restart-hold" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("releases restart-held follow-ups once the restart continuation settles", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:restart-hold-release");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-restart-hold-release"),
      threadId,
      projectId: ProjectId.make("project:restart-hold-release"),
      title: "Restart hold release",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    for (const name of ["cut", "first", "second"]) {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`dispatch:restart-hold-release:${name}`),
        threadId,
        messageId: MessageId.make(`message:restart-hold-release:${name}`),
        text: name,
        attachments: [],
        dispatchMode: { type: name === "cut" ? "start_immediately" : "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    }
    const [cut, ...queued] = (yield* projections.getThreadProjection(threadId)).runs;
    for (const run of [cut!, ...queued]) {
      yield* projections.apply({
        id: EventId.make(`event:restart-hold-release:${run.id}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload:
          run === cut
            ? { ...run, status: "cancelled", startedAt: now, completedAt: now }
            : { ...run, queueHeld: true, queueHoldReason: "restart" },
      });
    }
    const statuses = Effect.map(projections.getThreadProjection(threadId), (projection) =>
      projection.runs.map((run) => [run.status, run.queueHeld ?? false]),
    );
    yield* orchestrator.recoverDelegatedTask(threadId);
    assert.deepEqual(yield* statuses, [
      ["cancelled", false],
      ["queued", true],
      ["queued", true],
    ]);
    yield* orchestrator.recoverDelegatedTask(threadId, { sourceRunId: cut!.id });
    assert.deepEqual(yield* statuses, [
      ["cancelled", false],
      ["starting", false],
      ["queued", false],
    ]);
  }).pipe(Effect.provide(layerTest)),
);
