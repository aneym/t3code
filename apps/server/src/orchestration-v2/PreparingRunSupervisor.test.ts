import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, type OrchestrationV2RunStatus } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as DelegatedChildStartGate from "./DelegatedChildStartGate.ts";
import * as PreparingRunSupervisor from "./PreparingRunSupervisor.ts";
import { launchInput, makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const noHeldRuns = Layer.mock(DelegatedChildStartGate.DelegatedChildStartGate)({
  isHeld: () => false,
});

const commitOrphanedPreparation = (name: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const input = launchInput({
      command: `command:${name}`,
      thread: `thread:${name}`,
      workspace: { type: "worktree", baseRef: "main" },
    });
    yield* threads.dispatch({
      type: "thread.create",
      commandId: input.commandId,
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: null,
      worktreePath: null,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });
    const message = (ordinal: number, dispatchMode: "defer_start" | "queue_after_active") =>
      threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${input.commandId}:message:${ordinal}`),
        threadId: input.threadId,
        messageId: MessageId.make(`message:${name}:${ordinal}`),
        text: `Message ${ordinal}`,
        attachments: [],
        modelSelection: input.modelSelection,
        dispatchMode:
          dispatchMode === "defer_start"
            ? { type: "defer_start", workspaceStrategy: input.workspaceStrategy }
            : { type: "queue_after_active" },
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
    yield* message(1, "defer_start");
    yield* message(2, "queue_after_active");
    const projection = yield* threads.getThreadProjection(input.threadId);
    const run = projection.runs.find((candidate) => candidate.ordinal === 1)!;
    assert.equal(run.status, "preparing");
    assert.equal(projection.runs.find((candidate) => candidate.ordinal === 2)?.status, "queued");
    const status = (wanted: OrchestrationV2RunStatus) =>
      threads
        .streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence: 0,
          eventType: "run.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === run.id &&
              stored.event.payload.status === wanted,
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
    return { threadId: input.threadId, runId: run.id, status };
  });

it.effect("starts a committed worktree run that no request is preparing", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const orphan = yield* commitOrphanedPreparation("orphaned-preparation");
      const started = yield* orphan.status("starting");
      yield* Layer.build(PreparingRunSupervisor.layer.pipe(Layer.provide(noHeldRuns)));
      yield* TestClock.adjust(PreparingRunSupervisor.PREPARATION_ADOPT_AFTER);
      assert.isTrue(Option.isSome(yield* Fiber.join(started)));
      assert.equal(harness.createWorktree.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("fails a run whose workspace setup hangs past the deadline and names its queue", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const harness = makeHarness({
      createWorktree: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const orphan = yield* commitOrphanedPreparation("hung-preparation");
      const failed = yield* orphan.status("failed");
      yield* Layer.build(PreparingRunSupervisor.layer.pipe(Layer.provide(noHeldRuns)));
      yield* TestClock.adjust(PreparingRunSupervisor.PREPARATION_ADOPT_AFTER);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(PreparingRunSupervisor.PREPARATION_DEADLINE);
      assert.isTrue(Option.isSome(yield* Fiber.join(failed)));
      const projection = yield* threads.getThreadProjection(orphan.threadId);
      const failure = projection.turnItems.find(
        (item) => item.type === "error" && item.runId === orphan.runId,
      );
      assert.ok(failure?.type === "error");
      assert.equal(
        failure.failure.message,
        "Workspace setup did not finish within 10 minutes, so the agent never started on this message. The message queued behind it starts next.",
      );
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);
