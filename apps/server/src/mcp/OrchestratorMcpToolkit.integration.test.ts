import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  isProviderNativeSubagentThread,
  MessageId,
  type ModelSelection,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { makeOrchestratorMcpReplayFixture } from "./OrchestratorMcpReplay.testkit.ts";

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

describe("orchestrator MCP toolkit", () => {
  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
  ])("reports $label child results", ({ result, latestSummary }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layerTest } = yield* makeOrchestratorMcpReplayFixture({
          followupResult: result,
          instanceId: codexInstanceId,
          model: codexModel,
        });

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const parentCreate = yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP replay parent",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-replay-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: parentCreate.sequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Parent provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-replay"),
            requestNamespace: "mcp-provider-session-replay-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-replay-parent",
              providerInstanceId: codexInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const invoke = (name: string, args: Record<string, unknown>) =>
            server.callTool({ name, arguments: args }).pipe(
              Effect.tap((result) =>
                Effect.sync(() =>
                  expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(
                    true,
                  ),
                ),
              ),
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            );

          const delegationStartSequence =
            yield* orchestrator.getThreadEventSequence(parentThreadId);
          const delegatedCall = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
            },
            mode: "async",
            clientRequestId: "delegate-codex-replay-1",
          });
          const delegatedStart = yield* decodeDelegateTaskResult(
            delegatedCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegatedStart.childRunId).not.toBeNull();
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: delegationStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.type === "subagent_result" &&
                  stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                  stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Delegated result transfer was not created."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const delegatedStatusCall = yield* invoke("task_status", {
            taskId: delegatedStart.taskId,
          });
          const delegated = yield* decodeDelegateTaskResult(
            delegatedStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegated).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            providerInstanceId: codexInstanceId,
            hasPendingChildRuns: false,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });
          expect(delegated.resultContextTransferId).not.toBeNull();

          const delegatedChild = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
          expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
          const followupStartSequence = yield* orchestrator.getThreadEventSequence(
            delegated.childThreadId,
          );
          const runningFollowupCall = yield* invoke("t3_thread_send", {
            threadId: delegated.childThreadId,
            message: cancellationPrompt,
            clientRequestId: "delegated-child-replay-running-1",
          });
          const runningFollowup = yield* decodeThreadSendResult(
            runningFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: followupStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const queuedFollowupCall = yield* invoke("t3_thread_send", {
            threadId: delegated.childThreadId,
            message: queuedFollowupPrompt,
            mode: "queue",
            clientRequestId: "delegated-child-replay-queued-1",
          });
          const queuedFollowup = yield* decodeThreadSendResult(
            queuedFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(queuedFollowup).toMatchObject({
            status: "queued",
            delivery: "queued",
          });

          const pendingProjection = yield* orchestrator.getThreadProjection(
            delegated.childThreadId,
          );
          const followupTasks = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.filter(
            (task) =>
              task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
          );
          expect(followupTasks).toHaveLength(2);
          expect(followupTasks.every((task) => task.result === null)).toBe(true);
          expect(followupTasks.map((task) => task.id)).toEqual([
            runningFollowup.taskId,
            queuedFollowup.taskId,
          ]);
          expect(
            pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status,
          ).toBe("completed");
          expect(
            pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status,
          ).toBe("running");
          expect(
            pendingProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status,
          ).toBe("queued");
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
              (run) => run.status === "running",
            ),
          ).toBe(true);

          const pendingStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const pendingStatus = yield* decodeDelegateTaskResult(
            pendingStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(pendingStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: true,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });

          const finalSequence = yield* orchestrator.getThreadEventSequence(delegated.childThreadId);
          const interruptCall = yield* invoke("t3_thread_interrupt", {
            threadId: delegated.childThreadId,
            runId: runningFollowup.runId,
            reason: "Allow the queued replay follow-up to run.",
            clientRequestId: "interrupt-delegated-child-replay-1",
          });
          const interrupt = yield* decodeThreadInterruptResult(
            interruptCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(interrupt).toMatchObject({
            runId: runningFollowup.runId,
            status: "interrupt_requested",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === queuedFollowup.runId &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Queued follow-up did not complete."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const finalProjection = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
            "interrupted",
          );
          expect(finalProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
            "completed",
          );
          expect(
            finalProjection.turnItems.find(
              (item) =>
                item.runId === runningFollowup.runId && item.type === "run_interrupt_result",
            ),
          ).toMatchObject({
            message: "Stopped by an agent: Allow the queued replay follow-up to run.",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === followupTasks[1]!.id &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up task did not settle."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)?.status,
          ).toBe("interrupted");
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id),
          ).toMatchObject({
            status: "completed",
            result,
          });
          expect(
            finishedParent.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === delegated.childThreadId,
            ),
          ).toHaveLength(3);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const finalStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const finalStatus = yield* decodeDelegateTaskResult(
            finalStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(finalStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: false,
            latestTerminalRunId: queuedFollowup.runId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: latestSummary,
          });
          const followupTransfer = finishedParent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourcePoint.runId === queuedFollowup.runId,
          );
          expect(followupTransfer).toBeDefined();
          expect(finalStatus.latestTerminalResultContextTransferId).toBe(followupTransfer?.id);
          expect(finalStatus.latestTerminalResultContextTransferId).not.toBe(
            delegated.resultContextTransferId,
          );
          const read = yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            limit: 100,
          });
          expect(read.isError).not.toBe(true);
          const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            afterRead.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("acknowledged");
        }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(McpServer.McpServer.layer))));
      }),
    ),
  );
});
