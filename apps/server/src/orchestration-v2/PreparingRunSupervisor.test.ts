import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as DelegatedChildStartGate from "./DelegatedChildStartGate.ts";
import * as PreparingRunSupervisor from "./PreparingRunSupervisor.ts";
import * as ServerSettings from "../serverSettings.ts";
import { launchInput, makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
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

const roomHarness = () =>
  makeHarness({
    serverSettings: {
      childStart: { "*": { perGroup: 1 } },
      agentPlacementByRoom: true,
      agentPlacementMaxHoldMinutes: 1,
    },
  });

const launchRemoteChildren = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const gate = yield* DelegatedChildStartGate.DelegatedChildStartGate;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* Effect.forEach(
      names,
      (name) => {
        const input = launchInput({
          command: `command:${name}`,
          thread: `thread:${name}`,
          message: name,
        });
        return gate.admit({ projectId: input.projectId }, (held) =>
          launches.launch({
            ...input,
            createdBy: "agent",
            creationSource: "mcp",
            linkOrigin: { sessionId: "session:caller", label: "caller" },
            delegatedFrom: {
              environmentId: EnvironmentId.make("environment:caller"),
              threadId: ThreadId.make(`thread:parent:${name}`),
              title: "Parent",
            },
            ...(held ? { startHeld: true } : {}),
          }),
        );
      },
      { concurrency: "unbounded" },
    );
    const runs = yield* Effect.forEach(launched, (result) =>
      threads
        .getThreadProjection(result.threadId)
        .pipe(Effect.map((projection) => projection.runs[0]!)),
    );
    return { gate, threads, runs, held: runs.filter((run) => run.childStartHeld === true) };
  });

it.effect("admits two remote children for the last slot one at a time and holds the second", () =>
  Effect.gen(function* () {
    const harness = roomHarness();
    yield* Effect.gen(function* () {
      const { gate, runs, held } = yield* launchRemoteChildren(["race-a", "race-b"]);
      assert.equal(held.length, 1);
      assert.equal(runs.filter((run) => run.childStartHeld !== true).length, 1);
      assert.deepEqual(yield* gate.room, { cap: 1, active: 1, held: 1, free: 0 });
      const hold = yield* gate.hold(held[0]!.id);
      assert.equal(hold?.position, 1);
      assert.equal(
        hold?.reason,
        "All 1 builder slots on this machine are in use (1 running, 1 queued).",
      );
    }).pipe(
      Effect.provide(Layer.provideMerge(DelegatedChildStartGate.layer, harness.layer)),
      Effect.scoped,
    );
  }),
);

it.effect("starts a held remote child once room frees", () =>
  Effect.gen(function* () {
    const harness = roomHarness();
    yield* Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const { gate, threads, held } = yield* launchRemoteChildren(["free-a", "free-b"]);
      const child = held[0]!;
      yield* settings.updateSettings({ childStart: { "*": { perGroup: 2 } } });
      yield* TestClock.adjust("1 second");
      const { runs } = yield* threads.getThreadRecords(child.threadId, ["runs"]);
      assert.notEqual(runs[0]?.status, "preparing");
      assert.isFalse(gate.isHeld(runs[0]!));
    }).pipe(
      Effect.provide(Layer.provideMerge(DelegatedChildStartGate.layer, harness.layer)),
      Effect.scoped,
    );
  }),
);

it.effect("fails a held child that finds no room within the hold bound", () =>
  Effect.gen(function* () {
    const harness = roomHarness();
    yield* Effect.gen(function* () {
      const { threads, held } = yield* launchRemoteChildren(["bound-a", "bound-b"]);
      const child = held[0]!;
      yield* Layer.build(PreparingRunSupervisor.layer);
      yield* TestClock.adjust("70 seconds");
      const projection = yield* threads.getThreadProjection(child.threadId);
      assert.equal(projection.runs[0]?.status, "failed");
      const failure = projection.turnItems.find((item) => item.type === "error");
      assert.ok(failure?.type === "error");
      assert.equal(
        failure.failure.message,
        "No room on this machine within 1 min (All 1 builder slots on this machine are in use (1 running, 1 queued)). Delegate again to place it elsewhere.",
      );
    }).pipe(
      Effect.provide(Layer.provideMerge(DelegatedChildStartGate.layer, harness.layer)),
      Effect.scoped,
    );
  }),
);
