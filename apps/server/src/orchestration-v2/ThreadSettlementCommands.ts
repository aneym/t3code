import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { readAgentMainThreads } from "../agents/AgentHomeFiles.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { OrchestratorDispatchError } from "./OrchestratorDispatchError.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";

const SETTLE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;

export const makeSettlementCommands = Effect.fn("ThreadManagementService.makeSettlementCommands")(
  function* (
    dispatch: ThreadManagementServiceShape["dispatch"],
    waitForThread: ThreadManagementServiceShape["waitForThread"],
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
      const { run } = yield* waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
      if (run?.status !== "completed") return;
      const commandId = CommandId.make(`server:settle-after-run:${input.runId}`);
      yield* assertMcpSettlement(input.threadId, commandId);
      yield* dispatch({
        type: "thread.settle",
        source: "mcp",
        commandId,
        threadId: input.threadId,
      });
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
