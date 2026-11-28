import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { handoffBudget } from "@t3tools/provider-core/server/handoffBudget";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { parseSessionUpdateEvent } from "@t3tools/provider-acp/server/runtimeModel";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeAntigravityAcpRuntime } from "../provider/acp/AntigravityAcpSupport.ts";
import {
  antigravitySubagentOutput,
  normalizeAntigravitySessionUpdate,
  normalizeAntigravityToolCall,
} from "../provider/acp/AntigravityProtocol.ts";
import { makeTurnInput } from "./Adapters/AcpAdapterV2.testkit.ts";
import {
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./Adapters/AntigravityAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import { idleCompactionWindow, type IdleCompactionRecords } from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { rearmCancelledBackgroundWork } from "./RestartBackgroundRearm.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");
const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);

const layerAcpSession = Layer.mergeAll(
  NodeServices.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  IdAllocator.layer,
  McpProviderSessions.layer,
);

const bareFlavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity"),
  crypto: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in unit test"),
  withProcess: (_stop, task) => task,
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional default model is undefined here.
  defaultModel: Effect.succeed(undefined),
});

function makeLiveAntigravityAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly onPrompt: (
    payload: ReadonlyArray<EffectAcpSchema.ContentBlock>,
    send: (update: EffectAcpSchema.SessionUpdate) => Effect.Effect<void>,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse>;
  readonly sessionSetupModels?: EffectAcpSchema.SessionModelState;
}) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
    type SessionUpdateHandler = Parameters<RuntimeService["handleSessionUpdate"]>[0];
    let sessionUpdate: SessionUpdateHandler | undefined;
    return yield* makeAntigravityAdapterV2({
      instanceId: input.instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      makeRuntime: (runtimeInput) =>
        makeAntigravityAcpRuntime({
          ...runtimeInput,
          childProcessSpawner,
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: runtimeInput.cwd,
            env: { T3_ACP_ANTIGRAVITY: "1" },
          },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((runtime): RuntimeService => ({
            ...runtime,
            ...(input.sessionSetupModels === undefined
              ? {}
              : {
                  getConfigOptions: Effect.succeed([
                    {
                      id: "model",
                      name: "Model",
                      type: "select" as const,
                      currentValue: input.sessionSetupModels.currentModelId,
                      options: input.sessionSetupModels.availableModels.map((model) => ({
                        value: model.modelId,
                        name: model.name,
                      })),
                    },
                  ]),
                }),
            start: () =>
              runtime.start().pipe(
                Effect.map((started) =>
                  input.sessionSetupModels === undefined
                    ? started
                    : {
                        ...started,
                        sessionSetupResult: {
                          ...started.sessionSetupResult,
                          models: input.sessionSetupModels,
                        },
                      },
                ),
              ),
            handleSessionUpdate: (handler) =>
              Effect.sync(() => {
                sessionUpdate = handler;
              }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            prompt: (payload) =>
              input.onPrompt(payload.prompt, (update) =>
                sessionUpdate === undefined
                  ? Effect.die("adapter must register handleSessionUpdate")
                  : sessionUpdate(
                      normalizeAntigravitySessionUpdate({
                        sessionId: "mock-session-1",
                        update,
                      }),
                    ).pipe(Effect.orDie),
              ),
          })),
        ),
      withProcess: (_stop, task) => task,
      // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional default model is undefined here.
      defaultModel: Effect.succeed(undefined),
    });
  });
}

function makeIdleRecords(driver: ProviderDriverKind, instanceId: ProviderInstanceId) {
  const threadId = ThreadId.make(`idle:${driver}`);
  const runId = RunId.make(`run:${driver}`);
  const messageId = MessageId.make(`msg:${driver}`);
  const nodeId = NodeId.make(`node:${driver}`);
  const providerThreadId = ProviderThreadId.make(`pt:${driver}`);
  const modelSelection = { instanceId, model: "default" };
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-MINUTE_MS),
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Explain this code",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-MINUTE_MS),
        updatedAt: at(-MINUTE_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make(`turn:${driver}`),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: {
          usedTokens: 250_000,
          promptCacheExpiresAt: DateTime.formatIso(at(60 * MINUTE_MS)),
          updatedAt: DateTime.formatIso(at()),
        },
      },
    ],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
  } satisfies IdleCompactionRecords;
}

describe("Antigravity runtime parity hillclimb meter", () => {
  it("A1: preserves >8k Antigravity tool payloads without premature tail-truncation", () => {
    const head = "HEADER_SENTINEL_START\n";
    const tail = "\nFOOTER_SENTINEL_END";
    const output24k = `${head}${"x".repeat(24_000)}${tail}`;
    const normalizedUpdate = normalizeAntigravitySessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-24k",
        status: "completed",
        rawOutput: { combinedOutput: output24k, output: output24k },
        content: [{ type: "content", content: { type: "text", text: output24k } }],
      },
    });
    assert.equal(normalizedUpdate.update.sessionUpdate, "tool_call_update");
    if (normalizedUpdate.update.sessionUpdate !== "tool_call_update") return;
    const rawOutput = normalizedUpdate.update.rawOutput as Record<string, unknown>;
    assert.equal(rawOutput.combinedOutput, output24k);
    assert.equal(rawOutput.output, output24k);

    const normalizedCall = normalizeAntigravityToolCall({
      toolCallId: "cmd-24k",
      kind: "execute",
      status: "completed",
      data: { rawOutput: { combinedOutput: output24k } },
    });
    const item = normalizedCall.data.item as Record<string, unknown>;
    assert.equal(item.aggregatedOutput, output24k);
  });

  it.live("A2: AntigravityAdapterV2 preserves 24k command and tool outputs end-to-end", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-a2");
      const threadId = ThreadId.make("thread-a2");
      const largeOutput = `HEAD_MARKER\n${"a".repeat(24_000)}\nTAIL_MARKER`;
      const adapter = yield* makeLiveAntigravityAdapter({
        instanceId,
        onPrompt: (_payload, send) =>
          Effect.gen(function* () {
            yield* send({
              sessionUpdate: "tool_call",
              toolCallId: "call-large-cmd",
              title: "Running run_command",
              kind: "execute",
              status: "in_progress",
              rawInput: { CommandLine: "cat large.log" },
            });
            yield* send({
              sessionUpdate: "tool_call_update",
              toolCallId: "call-large-cmd",
              status: "completed",
              rawOutput: { combinedOutput: largeOutput, output: largeOutput, exitCode: 0 },
              content: [{ type: "content", content: { type: "text", text: largeOutput } }],
            });
            return { stopReason: "end_turn" };
          }),
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("ps-a2"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, modelSelection }),
      );
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const cmdItem = events
        .flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "call-large-cmd"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      assert.isDefined(cmdItem);
      assert.equal(cmdItem?.type, "command_execution");
      if (cmdItem?.type === "command_execution") {
        assert.equal(cmdItem.output, largeOutput);
      }
    }).pipe(Effect.provide(layerAcpSession), Effect.scoped),
  );

  it("A3: clamps runaway >300k payloads, strips inline images, and preserves default 8k runtimeModel cap", () => {
    const runaway = "r".repeat(350_000);
    const sanitized = normalizeAntigravitySessionUpdate({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-runaway",
        status: "completed",
        rawOutput: {
          combinedOutput: runaway,
          formatted_output: runaway,
          screenshot: { type: "image", mimeType: "image/png", data: "AAAA".repeat(10_000) },
        },
      },
    });
    assert.equal(sanitized.update.sessionUpdate, "tool_call_update");
    if (sanitized.update.sessionUpdate === "tool_call_update") {
      const rawOutput = sanitized.update.rawOutput as Record<string, unknown>;
      assert.isBelow(String(rawOutput.combinedOutput).length, 300_000);
      assert.isUndefined(rawOutput.formatted_output);
      assert.isUndefined((rawOutput.screenshot as Record<string, unknown> | undefined)?.data);
    }

    const parsedDefault = parseSessionUpdateEvent({
      sessionId: "grok-s1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "grok-1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "g".repeat(20_000) } }],
      },
    });
    const toolEvent = parsedDefault.events.find((event) => event._tag === "ToolCallUpdated");
    assert.isDefined(toolEvent);
    if (toolEvent?._tag === "ToolCallUpdated") {
      assert.isBelow(toolEvent.toolCall.detail?.length ?? 0, 8_100);
    }
  });

  it.live(
    "B1: Antigravity getModelContextWindow returns 1M for Gemini models (no 128k handoffBudget clamp)",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity-b1");
        const threadId = ThreadId.make("thread-b1");
        const adapter = yield* makeLiveAntigravityAdapter({
          instanceId,
          sessionSetupModels: {
            currentModelId: "gemini-3.5-pro",
            availableModels: [
              {
                modelId: "gemini-3.5-pro",
                name: "Gemini 3.5 Pro",
                _meta: { totalContextTokens: 1_048_576 },
              },
              {
                modelId: "gemini-4-neon",
                name: "Gemini 4 Neon",
              },
            ],
          },
          onPrompt: () => Effect.succeed({ stopReason: "end_turn" }),
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: ANTIGRAVITY_DEFAULT_MODEL } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("ps-b1"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        assert.isDefined(session.getModelContextWindow);
        const defaultWindow = session.getModelContextWindow?.({
          instanceId,
          model: ANTIGRAVITY_DEFAULT_MODEL,
        });
        const neonWindow = session.getModelContextWindow?.({
          instanceId,
          model: "gemini-4-neon",
        });
        assert.equal(defaultWindow, 1_048_576);
        assert.equal(neonWindow, 1_000_000);
        const budget = handoffBudget({
          tokenCap: 16_000,
          userText: "continue",
          attachments: [],
          providerThread: {
            ...providerThread,
            contextUsage: {
              usedTokens: 150_000,
              maxTokens: neonWindow,
            } satisfies ThreadTokenUsageSnapshot,
          },
          nativeContextEstimate: 150_000,
          modelContextWindow: neonWindow,
        });
        assert.isAbove(budget, 0);
      }).pipe(Effect.provide(layerAcpSession), Effect.scoped),
  );

  it("B2: Antigravity canReuseContextUsage reuses across thinking levels and rejects model switches", () => {
    const instanceId = ProviderInstanceId.make("antigravity");
    const otherInstance = ProviderInstanceId.make("antigravity-2");
    const canReuse = bareFlavor.canReuseContextUsage;
    assert.isDefined(canReuse);
    assert.isTrue(
      canReuse?.(
        {
          instanceId,
          model: "gemini-3.5-pro",
          options: [{ id: "thought_level", value: "low" }],
        },
        {
          instanceId,
          model: "gemini-3.5-pro",
          options: [{ id: "thought_level", value: "high" }],
        },
      ),
    );
    assert.isTrue(
      canReuse?.(
        { instanceId, model: "gemini-3.5-pro-low" },
        { instanceId, model: "gemini-3.5-pro-high" },
      ),
    );
    assert.isFalse(
      canReuse?.(
        { instanceId, model: "gemini-3.5-pro" },
        { instanceId, model: "claude-sonnet-4-6" },
      ),
    );
    assert.isFalse(
      canReuse?.(
        { instanceId, model: "gemini-3.5-pro" },
        { instanceId: otherInstance, model: "gemini-3.5-pro" },
      ),
    );
  });

  it("B3: FULL_CATALOG_DRIVERS in OrchestratorMcpService includes antigravity", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("../mcp/OrchestratorMcpService.ts", import.meta.url),
      "utf8",
    );
    const match = /FULL_CATALOG_DRIVERS[\s\S]*?new Set\(\[([^\]]+)\]\)/.exec(source);
    assert.isNotNull(match);
    assert.include(match?.[1] ?? "", '"antigravity"');
  });

  it("C1: idleCompactionWindow works for compaction-capable Antigravity/Codex without claudeAgent hardcoding", () => {
    const agRecords = makeIdleRecords(ANTIGRAVITY_PROVIDER, ProviderInstanceId.make("antigravity"));
    const codexRecords = makeIdleRecords(CODEX_PROVIDER, ProviderInstanceId.make("codex"));
    assert.isNotNull(idleCompactionWindow(agRecords, NOW_MS));
    assert.isNotNull(idleCompactionWindow(codexRecords, NOW_MS));
    assert.strictEqual(Reflect.get(bareFlavor.capabilities.context, "supportsCompaction"), true);
    assert.strictEqual(
      Reflect.get(ClaudeProviderCapabilitiesV2.context, "supportsCompaction"),
      true,
    );
    assert.strictEqual(
      Reflect.get(CodexProviderCapabilitiesV2.context, "supportsCompaction"),
      true,
    );
  });

  it.effect(
    "C2: Orchestrator subagent.stop is driven by adapter capability rather than claudeAgent hardcoding",
    () =>
      Effect.gen(function* () {
        const agInstanceId = ProviderInstanceId.make("antigravity");
        const agCapabilities = {
          ...bareFlavor.capabilities,
          subagents: {
            ...bareFlavor.capabilities.subagents,
            canStopSubagents: true,
          },
        } as OrchestrationV2ProviderCapabilities;
        const agAdapter = {
          instanceId: agInstanceId,
          driver: ANTIGRAVITY_PROVIDER,
          getCapabilities: () => Effect.succeed(agCapabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("unused"),
        } as ProviderAdapter.ProviderAdapterV2["Service"];
        const layerDb = SqlitePersistence.layerMemory;
        const layer = ProviderReplayHarness.layerWithRegistry(
          { name: "parity-c2" },
          ProviderAdapterRegistry.layerFromAdapters([agAdapter]),
          { databaseLayer: layerDb, runEffectWorker: false },
        ).pipe(
          Layer.provideMerge(ProjectionStore.layer.pipe(Layer.provide(layerDb))),
          Layer.provideMerge(layerDb),
          Layer.provideMerge(ServerSettings.layerTest()),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const threadId = ThreadId.make("thread-c2");
          const modelSelection = { instanceId: agInstanceId, model: "gemini-3.5-pro" };
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("c2:create"),
            threadId,
            projectId: ProjectId.make("project:c2"),
            title: "C2",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("c2:send"),
            threadId,
            messageId: MessageId.make("c2:msg"),
            text: "start",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          const before = yield* orchestrator.getThreadProjection(threadId);
          const run = before.runs[0]!;
          const providerThread = before.providerThreads.find(
            (pt) => pt.id === run.providerThreadId,
          )!;
          const now = yield* DateTime.now;
          const subagentId = NodeId.make("node:c2:subagent");
          yield* projections.apply({
            id: EventId.make("c2:pt"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...providerThread,
              driver: ANTIGRAVITY_PROVIDER,
              providerInstanceId: agInstanceId,
              providerSessionId: ProviderSessionId.make("session:c2"),
            },
          });
          yield* projections.apply({
            id: EventId.make("c2:turn"),
            type: "provider-turn.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: ProviderTurnId.make("turn:c2"),
              providerThreadId: providerThread.id,
              nodeId: run.rootNodeId!,
              runAttemptId: run.activeAttemptId!,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          });
          yield* projections.apply({
            id: EventId.make("c2:subagent"),
            type: "subagent.updated",
            threadId,
            runId: run.id,
            nodeId: subagentId,
            providerInstanceId: agInstanceId,
            occurredAt: now,
            payload: {
              id: subagentId,
              threadId,
              runId: run.id,
              parentNodeId: run.rootNodeId!,
              origin: "provider_native",
              createdBy: "agent",
              driver: ANTIGRAVITY_PROVIDER,
              providerInstanceId: agInstanceId,
              providerThreadId: providerThread.id,
              childThreadId: null,
              nativeTaskRef: {
                driver: ANTIGRAVITY_PROVIDER,
                nativeId: "ag-task-1",
                strength: "strong",
              },
              prompt: "audit",
              title: "Auditor",
              model: null,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            } satisfies OrchestrationV2Subagent,
          });
          const exit = yield* Effect.exit(
            orchestrator.dispatch({
              type: "subagent.stop",
              commandId: CommandId.make("c2:stop"),
              threadId,
              runId: run.id,
              subagentId,
            }),
          );
          assert.isTrue(Exit.isSuccess(exit));
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "C3: ThreadManagementService.stopWorkflow supports any provider_native driver whose session exposes stopTask",
    () =>
      Effect.gen(function* () {
        const agInstanceId = ProviderInstanceId.make("antigravity");
        const threadId = ThreadId.make("thread-c3");
        const runId = RunId.make("run-c3");
        const subagentId = NodeId.make("subagent-c3");
        const providerThreadId = ProviderThreadId.make("pt-c3");
        const providerSessionId = ProviderSessionId.make("session-c3");
        const now = yield* DateTime.now;
        let stoppedTaskId: string | undefined;
        const providerThread: OrchestrationV2ProviderThread = {
          id: providerThreadId,
          driver: ANTIGRAVITY_PROVIDER,
          providerInstanceId: agInstanceId,
          providerSessionId,
          appThreadId: threadId,
          ownerNodeId: NodeId.make("root-c3"),
          nativeThreadRef: {
            driver: ANTIGRAVITY_PROVIDER,
            nativeId: "native-c3",
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: [],
          createdAt: now,
          updatedAt: now,
        };
        const layerDb = SqlitePersistence.layerMemory;
        const agAdapter = {
          instanceId: agInstanceId,
          driver: ANTIGRAVITY_PROVIDER,
          getCapabilities: () => Effect.succeed(bareFlavor.capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () => Effect.die("unused"),
        } as ProviderAdapter.ProviderAdapterV2["Service"];
        const fakeSession = {
          instanceId: agInstanceId,
          driver: ANTIGRAVITY_PROVIDER,
          providerSessionId,
          stopTask: ({ taskId }: { readonly taskId: string }) =>
            Effect.sync(() => {
              stoppedTaskId = taskId;
            }),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
        const layer = ThreadManagementService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ProjectionStore.layer.pipe(Layer.provide(layerDb)),
              EventStore.layer.pipe(Layer.provide(layerDb)),
              EffectOutbox.layer.pipe(Layer.provide(layerDb)),
              CommandReceiptStore.layer.pipe(Layer.provide(layerDb)),
              ProviderReplayHarness.layerWithRegistry(
                { name: "parity-c3" },
                ProviderAdapterRegistry.layerFromAdapters([agAdapter]),
                { databaseLayer: layerDb, runEffectWorker: false },
              ),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                get: (id) =>
                  Effect.succeed(
                    id === providerSessionId ? Option.some(fakeSession) : Option.none(),
                  ),
              }),
              ServerSettings.layerTest(),
            ),
          ),
          Layer.provideMerge(ProjectionStore.layer.pipe(Layer.provide(layerDb))),
          Layer.provideMerge(layerDb),
        );
        yield* Effect.gen(function* () {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const threadManagement = yield* ThreadManagementService.ThreadManagementService;
          const modelSelection = { instanceId: agInstanceId, model: "gemini-3.5-pro" };
          yield* projections.apply({
            id: EventId.make("c3:thread"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              id: threadId,
              projectId: ProjectId.make("project:c3"),
              title: "C3",
              createdBy: "user",
              creationSource: "web",
              providerInstanceId: agInstanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThreadId,
              lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: now,
              deletedAt: null,
            },
          });
          yield* projections.apply({
            id: EventId.make("c3:pt"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: providerThread,
          });
          yield* projections.apply({
            id: EventId.make("c3:subagent"),
            type: "subagent.updated",
            threadId,
            runId,
            nodeId: subagentId,
            providerInstanceId: agInstanceId,
            occurredAt: now,
            payload: {
              id: subagentId,
              threadId,
              runId,
              parentNodeId: NodeId.make("root-c3"),
              origin: "provider_native",
              createdBy: "agent",
              driver: ANTIGRAVITY_PROVIDER,
              providerInstanceId: agInstanceId,
              providerThreadId,
              childThreadId: null,
              nativeTaskRef: {
                driver: ANTIGRAVITY_PROVIDER,
                nativeId: "wf-task-42",
                strength: "strong",
              },
              prompt: "workflow",
              title: "Workflow",
              model: null,
              status: "running",
              result: null,
              workflow: {
                name: "wf",
                phases: [],
                agents: [],
              },
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            } as unknown as OrchestrationV2Subagent,
          });
          yield* threadManagement.stopWorkflow({ threadId, subagentId });
          assert.equal(stoppedTaskId, "wf-task-42");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "C4: RestartBackgroundRearm generates subagent resume hints for non-Claude drivers",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-c4");
        const providerThreadId = ProviderThreadId.make("pt-c4");
        const now = yield* DateTime.now;
        const rearmed = yield* rearmCancelledBackgroundWork(
          [
            {
              kind: "subagent",
              id: "subagent-99",
              label: "Codebase auditor (subagent subagent-99)",
            },
          ],
          {
            thread: { id: threadId } as never,
            providerThreads: [
              {
                id: providerThreadId,
                driver: ANTIGRAVITY_PROVIDER,
                providerInstanceId: ProviderInstanceId.make("antigravity"),
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: NodeId.make("root-c4"),
                nativeThreadRef: {
                  driver: ANTIGRAVITY_PROVIDER,
                  nativeId: "native-c4",
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          providerThreadId,
          {
            getThreadRecords: () =>
              Effect.succeed({ turnItems: [] as ReadonlyArray<OrchestrationV2TurnItem> } as never),
          },
        ).pipe(Effect.provideService(HostProcess.Platform, "linux"));
        assert.isDefined(rearmed[0]?.rearm);
        assert.include(rearmed[0]?.rearm ?? "", "subagent-99");
      }),
  );

  it("C5: ProviderTurnStartService missing-session recovery is not gated to claudeAgent", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./ProviderTurnStartService.ts", import.meta.url),
      "utf8",
    );
    assert.notInclude(source, 'session.driver === "claudeAgent"');
  });

  it("C6: /goal command recognition is capability-driven for Codex, Claude, and Antigravity", () => {
    assert.equal(Reflect.get(CodexProviderCapabilitiesV2.turns, "goalCommands"), "full");
    assert.equal(
      Reflect.get(ClaudeProviderCapabilitiesV2.turns, "goalCommands"),
      "without_pause_resume",
    );
    assert.equal(
      Reflect.get(bareFlavor.capabilities.turns, "goalCommands"),
      "without_pause_resume",
    );
  });

  it("D1: antigravitySubagentOutput extracts nested error.message and stderr on failed subagent calls", () => {
    const nestedError = antigravitySubagentOutput({
      toolCallId: "sub-err-1",
      kind: "other",
      title: "Running invoke_subagent",
      status: "failed",
      data: {
        rawOutput: { error: { code: "DEADLINE_EXCEEDED", message: "Subagent request timed out" } },
      },
    });
    assert.equal(nestedError, "Subagent request timed out");

    const stderrFailure = antigravitySubagentOutput({
      toolCallId: "sub-err-2",
      kind: "other",
      title: "Running invoke_subagent",
      status: "failed",
      data: {
        rawOutput: { stderr: "Permission denied reading workspace" },
      },
    });
    assert.equal(stderrFailure, "Permission denied reading workspace");
  });

  it.live(
    "D2: concurrent Antigravity subagent batch preserves distinct completed, failed, and settled traces",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity-d2");
        const threadId = ThreadId.make("thread-d2");
        const adapter = yield* makeLiveAntigravityAdapter({
          instanceId,
          onPrompt: (_payload, send) =>
            Effect.gen(function* () {
              yield* send({
                sessionUpdate: "tool_call",
                toolCallId: "batch:1",
                title: "Running invoke_subagent",
                kind: "other",
                status: "in_progress",
                rawInput: { Prompt: "Check auth", Role: "Auth Auditor" },
              });
              yield* send({
                sessionUpdate: "tool_call",
                toolCallId: "batch:2",
                title: "Running invoke_subagent",
                kind: "other",
                status: "in_progress",
                rawInput: { Prompt: "Check billing", Role: "Billing Auditor" },
              });
              yield* send({
                sessionUpdate: "tool_call",
                toolCallId: "batch:3",
                title: "Running start_subagent",
                kind: "other",
                status: "in_progress",
                rawInput: { Prompt: "Check metrics", Role: "Metrics Auditor" },
              });
              yield* send({
                sessionUpdate: "tool_call_update",
                toolCallId: "batch:1",
                status: "completed",
                rawOutput: "Auth OK",
              });
              yield* send({
                sessionUpdate: "tool_call_update",
                toolCallId: "batch:2",
                status: "failed",
                rawOutput: { error: { message: "Billing API 503" } },
              });
              return { stopReason: "end_turn" };
            }),
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("ps-d2"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            modelSelection,
          }),
        );
        const events = Array.from(
          yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const latestByNativeId = (nativeId: string) =>
          events
            .flatMap((event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === nativeId
                ? [event.subagent]
                : [],
            )
            .at(-1);
        assert.equal(latestByNativeId("batch:1")?.status, "completed");
        assert.equal(latestByNativeId("batch:1")?.result, "Auth OK");
        assert.equal(latestByNativeId("batch:2")?.status, "failed");
        assert.equal(latestByNativeId("batch:2")?.result, "Billing API 503");
        assert.equal(latestByNativeId("batch:3")?.status, "completed");
      }).pipe(Effect.provide(layerAcpSession), Effect.scoped),
  );

  it.live(
    "D3: follow-up terminal subagent update carrying late result populates subagent.result",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity-d3");
        const threadId = ThreadId.make("thread-d3");
        const adapter = yield* makeLiveAntigravityAdapter({
          instanceId,
          onPrompt: (_payload, send) =>
            Effect.gen(function* () {
              yield* send({
                sessionUpdate: "tool_call",
                toolCallId: "late-res:1",
                title: "Running invoke_subagent",
                kind: "other",
                status: "in_progress",
                rawInput: { Prompt: "Inspect trace", Role: "Trace Auditor" },
              });
              yield* send({
                sessionUpdate: "tool_call_update",
                toolCallId: "late-res:1",
                status: "completed",
              });
              yield* send({
                sessionUpdate: "tool_call_update",
                toolCallId: "late-res:1",
                status: "completed",
                rawOutput: "Late trace summary",
              });
              return { stopReason: "end_turn" };
            }),
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("ps-d3"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            modelSelection,
          }),
        );
        const events = Array.from(
          yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const finalSubagent = events
          .flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === "late-res:1"
              ? [event.subagent]
              : [],
          )
          .at(-1);
        assert.equal(finalSubagent?.status, "completed");
        assert.equal(finalSubagent?.result, "Late trace summary");
      }).pipe(Effect.provide(layerAcpSession), Effect.scoped),
  );

  it.live(
    "E1: /compact turn with native compaction_update emits 1 compaction item (no duplicate) and clears usage",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity-e1");
        const threadId = ThreadId.make("thread-e1");
        let turnCount = 0;
        const adapter = yield* makeLiveAntigravityAdapter({
          instanceId,
          onPrompt: (_payload, send) =>
            Effect.gen(function* () {
              turnCount += 1;
              if (turnCount === 1) {
                yield* send({
                  sessionUpdate: "usage_update",
                  used: 90_000,
                  size: 1_000_000,
                });
                return { stopReason: "end_turn" };
              }
              yield* send({
                sessionUpdate: "compaction_update",
                compactionId: "cmp-1",
                status: "completed",
                summary: [{ type: "text", text: "Compacted conversation." }],
              });
              return { stopReason: "end_turn" };
            }),
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("ps-e1"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 1,
            modelSelection,
            messageText: "hello",
          }),
        );
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 2,
            modelSelection,
            messageText: "/compact",
          }),
        );
        const compactEvents = Array.from(
          yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const compactionIds = new Set(
          compactEvents.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "compaction"
              ? [event.turnItem.id]
              : [],
          ),
        );
        assert.equal(compactionIds.size, 1);
        const threadUpdate = compactEvents.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        assert.equal(threadUpdate?.type, "provider_thread.updated");
        if (threadUpdate?.type === "provider_thread.updated") {
          assert.isNull(threadUpdate.providerThread.contextUsage);
        }
      }).pipe(Effect.provide(layerAcpSession), Effect.scoped),
  );

  it.live(
    "E2: /compact turn with failed native compaction_update preserves contextUsage and avoids fake completed item",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity-e2");
        const threadId = ThreadId.make("thread-e2");
        let turnCount = 0;
        const adapter = yield* makeLiveAntigravityAdapter({
          instanceId,
          onPrompt: (_payload, send) =>
            Effect.gen(function* () {
              turnCount += 1;
              if (turnCount === 1) {
                yield* send({
                  sessionUpdate: "usage_update",
                  used: 95_000,
                  size: 1_000_000,
                });
                return { stopReason: "end_turn" };
              }
              yield* send({
                sessionUpdate: "compaction_update",
                compactionId: "cmp-fail-1",
                status: "failed",
                error: "Nothing to compact",
              });
              return { stopReason: "end_turn" };
            }),
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("ps-e2"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 1,
            modelSelection,
            messageText: "hello",
          }),
        );
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 2,
            modelSelection,
            messageText: "/compact",
          }),
        );
        const compactEvents = Array.from(
          yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const completedCompactions = compactEvents.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "compaction" &&
            event.turnItem.status === "completed",
        );
        assert.equal(completedCompactions.length, 0);
        const threadUpdate = compactEvents.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        assert.equal(threadUpdate?.type, "provider_thread.updated");
        if (threadUpdate?.type === "provider_thread.updated") {
          assert.equal(threadUpdate.providerThread.contextUsage?.usedTokens, 95_000);
        }
      }).pipe(Effect.provide(layerAcpSession), Effect.scoped),
  );

  it.live(
    "E3: case-insensitive /COMPACT resets usage while failed /compact preserves contextUsage",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("antigravity-e3");
        const threadId = ThreadId.make("thread-e3");
        let turnCount = 0;
        const adapter = yield* makeLiveAntigravityAdapter({
          instanceId,
          onPrompt: (_payload, send) =>
            Effect.gen(function* () {
              turnCount += 1;
              if (turnCount === 1) {
                yield* send({
                  sessionUpdate: "usage_update",
                  used: 88_000,
                  size: 1_000_000,
                });
                return { stopReason: "end_turn" };
              }
              if (turnCount === 2) {
                return { stopReason: "cancelled" };
              }
              return { stopReason: "end_turn" };
            }),
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("ps-e3"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 1,
            modelSelection,
            messageText: "hello",
          }),
        );
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        // Turn 2: cancelled /compact must preserve usage
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 2,
            modelSelection,
            messageText: "/compact",
          }),
        );
        const cancelledEvents = Array.from(
          yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const cancelledThread = cancelledEvents.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        assert.equal(cancelledThread?.type, "provider_thread.updated");
        if (cancelledThread?.type === "provider_thread.updated") {
          assert.equal(cancelledThread.providerThread.contextUsage?.usedTokens, 88_000);
        }
        // Turn 3: uppercase /COMPACT must reset usage
        yield* session.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 3,
            modelSelection,
            messageText: "/COMPACT",
          }),
        );
        const compactEvents = Array.from(
          yield* session.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const completedThread = compactEvents.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        assert.equal(completedThread?.type, "provider_thread.updated");
        if (completedThread?.type === "provider_thread.updated") {
          assert.isNull(completedThread.providerThread.contextUsage);
        }
      }).pipe(Effect.provide(layerAcpSession), Effect.scoped),
  );
});
