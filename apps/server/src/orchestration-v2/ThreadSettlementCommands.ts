import { CommandId, type OrchestrationV2Run, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import { readAgentMainThreads } from "../agents/AgentHomeFiles.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { OrchestratorDispatchError } from "./OrchestratorDispatchError.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";

const SETTLE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;

const TERMINAL_RUN_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
];

export const makeSettlementCommands = Effect.fn("ThreadManagementService.makeSettlementCommands")(
  function* (
    dispatch: ThreadManagementServiceShape["dispatch"],
    waitForThread: ThreadManagementServiceShape["waitForThread"],
    loadRecords: ThreadManagementServiceShape["getProjectThreadRecords"],
  ) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const layerScope = yield* Effect.scope;
    const environment = yield* Effect.serviceOption(ServerEnvironmentIdentity);
    const assertMcpSettlement = Effect.fn("ThreadManagementService.assertMcpSettlement")(function* (
      threadId: ThreadId,
      commandId: CommandId,
    ) {
      const environmentId = Option.isSome(environment)
        ? yield* environment.value.getEnvironmentId
        : undefined;
      const bindings = yield* Effect.tryPromise({
        try: () => readAgentMainThreads(environmentId),
        catch: () =>
          new OrchestratorDispatchError({
            commandId,
            commandType: "thread.settle",
            cause:
              "Cannot verify agent-home bindings; refusing MCP settlement. Use an explicit user settle in the client or CLI.",
          }),
      });
      if (bindings.has(threadId))
        return yield* new OrchestratorDispatchError({
          commandId,
          commandType: "thread.settle",
          cause:
            "Agent-home main threads cannot be settled by MCP or their agent. Use an explicit user settle in the client or CLI.",
        });
    });
    const settleAfterRun: ThreadManagementServiceShape["settleAfterRun"] = Effect.fn(
      "orchestrationV2.threadManagement.settleAfterRun",
    )(function* (input) {
      const requestedAt = yield* DateTime.now;
      const { run } = yield* waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
      if (run?.status !== "completed") return;
      yield* assertMcpSettlement(
        input.threadId,
        CommandId.make(`server:settle-after-run:${input.runId}`),
      );
      const afterSequence = yield* orchestrator.getThreadEventSequence(input.threadId);
      const trySettle = Effect.gen(function* () {
        const sequence = yield* orchestrator.getThreadEventSequence(input.threadId);
        const records = yield* loadRecords(input, ["runs"]);
        if (
          threadPullRequestsOf(records.thread).some(
            (link) =>
              link.watch !== undefined &&
              !DateTime.isLessThan(DateTime.makeUnsafe(link.watch.startedAt), requestedAt),
          )
        )
          return true;
        const following = records.runs.filter((candidate) => candidate.ordinal > run.ordinal);
        if (following.length > 0) {
          const { messages } = yield* loadRecords(input, ["messages"], {
            messageRunIds: following.map((candidate) => candidate.id),
            messageRoles: ["user"],
          });
          const automaticMessageIds = new Set(
            messages
              .filter(
                (message) =>
                  message.role === "user" &&
                  (message.notification !== undefined || message.delegatedCompletion !== undefined),
              )
              .map((message) => message.id),
          );
          if (
            messages.some((message) => !automaticMessageIds.has(message.id)) ||
            following.some((candidate) => !automaticMessageIds.has(candidate.userMessageId))
          )
            return true;
          if (
            following.some(
              (candidate) =>
                candidate.status !== "queued" && !TERMINAL_RUN_STATUSES.includes(candidate.status),
            )
          )
            return false;
          if (
            following.some(
              (candidate) => candidate.status !== "queued" && candidate.status !== "completed",
            )
          )
            return true;
        }
        const latest = records.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
        if (latest === undefined) return true;
        return yield* dispatch({
          type: "thread.settle",
          source: "mcp",
          commandId: CommandId.make(`server:settle-after-run:${input.runId}:${sequence}`),
          threadId: input.threadId,
          expectedLatestRunId: latest.id,
        }).pipe(
          Effect.as(true),
          Effect.catchTags({
            OrchestratorDispatchError: () => Effect.succeed(false),
            OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed(false),
          }),
        );
      });
      yield* Stream.fromEffect(trySettle).pipe(
        Stream.concat(
          orchestrator
            .streamStoredEventsFrom({
              threadId: input.threadId,
              afterSequence,
              eventType: "run.updated",
            })
            .pipe(Stream.mapEffect(() => trySettle)),
        ),
        Stream.filter((done) => done),
        Stream.runHead,
        Effect.timeoutOption(Duration.millis(SETTLE_AFTER_RUN_WAIT_MS)),
      );
    });

    const settleThread: ThreadManagementServiceShape["settleThread"] = Effect.fn(
      "orchestrationV2.threadManagement.settleThread",
    )(function* (input) {
      if (!input.byUser || input.byOwnAgent)
        yield* assertMcpSettlement(input.threadId, input.commandId);
      const shell = input.byOwnAgent ? yield* orchestrator.getThreadShell(input.threadId) : null;
      if (shell != null && shell.activeRunId !== null) {
        yield* settleAfterRun({
          projectId: shell.projectId,
          threadId: shell.id,
          runId: shell.activeRunId,
        }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
        return { settlesWhenTurnEnds: true } as const;
      }
      const result = yield* dispatch({
        type: "thread.settle",
        source: input.byUser && !input.byOwnAgent ? "user" : "mcp",
        commandId: input.commandId,
        threadId: input.threadId,
      });
      return { sequence: result.sequence };
    });

    return { settleAfterRun, settleThread };
  },
);
