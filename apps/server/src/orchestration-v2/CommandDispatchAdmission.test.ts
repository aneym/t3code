import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { makeCommandDispatchAdmission } from "./CommandDispatchAdmission.ts";
import { DispatchAdmissionBound } from "./DispatchAdmissionBound.ts";
import { makeDispatchGate } from "./DispatchGate.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-dispatch-busy-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const parentThreadId = ThreadId.make("thread:busy-parent");
const otherThreadId = ThreadId.make("thread:busy-other");

const delegate: OrchestrationV2ServerCommand = {
  type: "delegated_task.request",
  createdBy: "agent",
  creationSource: "mcp",
  commandId: CommandId.make("busy-delegate"),
  parentThreadId,
  parentRunId: RunId.make("busy-parent-run"),
  parentNodeId: NodeId.make("busy-parent-node"),
  task: "Hold the gate",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

const send = (threadId: ThreadId): OrchestrationV2ServerCommand => ({
  type: "message.dispatch",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make(`busy-send:${threadId}`),
  threadId,
  messageId: MessageId.make(`busy-send:${threadId}`),
  text: "Plain send",
  attachments: [],
  dispatchMode: { type: "queue_after_active" },
});

it.effect("logs one busy line per dispatch that times out behind a held lock", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const exits = yield* Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* makeDispatchGate;
        const admission = makeCommandDispatchAdmission({
          execute: (command) =>
            command.type === "delegated_task.request"
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          findThread: () => Effect.succeed(null),
          liveSideChatIds: () => Effect.succeed([]),
          commandThreadId: (command) =>
            command.type === "delegated_task.request"
              ? command.parentThreadId
              : command.type === "message.dispatch"
                ? command.threadId
                : parentThreadId,
          mayStartFollowup: () => false,
          parentThreadId: () => Effect.undefined,
          outbox: gate,
          locks: yield* KeyedLock.make<ThreadId>(),
          intake: yield* KeyedLock.make<ThreadId>(),
        });
        const holder = yield* Effect.forkScoped(admission.dispatch(delegate));
        yield* Deferred.await(started);
        const bounded = (command: OrchestrationV2ServerCommand) =>
          admission
            .dispatch(command)
            .pipe(Effect.provideService(DispatchAdmissionBound, 0), Effect.exit);
        const gateWait = yield* bounded(send(otherThreadId));
        const threadWait = yield* bounded(send(parentThreadId));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        return [gateWait, threadWait];
      }),
    );
    for (const exit of exits) {
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) && exit.cause), "OrchestratorDispatchBusyError");
    }
    const lines = (yield* fileSystem.readFileString(
      path.join(config.logsDir, "dispatch-gate.ndjson"),
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.k === "busy")
      .map(({ t: _t, waitMs, holdMs, ...line }) => {
        assert.isNumber(waitMs);
        assert.isNumber(holdMs);
        return line;
      });
    assert.deepEqual(lines, [
      {
        k: "busy",
        type: "message.dispatch",
        thread: otherThreadId,
        lock: "gate",
        queue: 1,
        holder: "delegated_task.request",
        holderThread: parentThreadId,
        phase: "-",
      },
      {
        k: "busy",
        type: "message.dispatch",
        thread: parentThreadId,
        lock: "thread",
        lockThread: parentThreadId,
        queue: 1,
        holder: "delegated_task.request",
        holderThread: parentThreadId,
      },
    ]);
  }).pipe(Effect.provide(layer)),
);
