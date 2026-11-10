import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";
import { type RunId, ThreadId } from "@t3tools/contracts";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import {
  type AgentThread,
  agentToolProperties,
  handoffSettings,
  MAX_REPORTED_DEPTH,
  toolOutcome,
} from "../../telemetry/ProviderDimensions.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";

/**
 * Tools that hand work to another thread's agent: they create it, message it,
 * steer it, or move context into it. Their events name the receiving agent too.
 */
const HANDOFF_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "create_threads",
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_send_attachments",
  "schedule_task",
  "run_scheduled_task_now",
]);

const INPUT_TARGET_ACTIONS = {
  t3_queue: new Set(["edit", "promote_to_steer", "send_all"]),
  t3_pending_request: new Set(["respond", "dismiss"]),
};

const RESULT_TARGET_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  t3_thread_transfer: new Set(["fork", "merge_back"]),
};

const hasAction = (
  actions: Readonly<Record<string, ReadonlySet<string>>>,
  tool: string,
  args: unknown,
) =>
  actions[tool]?.has(String((args as { readonly action?: unknown } | null | undefined)?.action)) ===
  true;

const isInputTargetHandoff = (tool: string, args: unknown) =>
  hasAction(INPUT_TARGET_ACTIONS, tool, args);

const resultThreadKeys = ["childThreadId", "targetThreadId", "boundThreadId", "threadId"] as const;

const resultThreadIds = (content: unknown): ReadonlyArray<string> => {
  if (typeof content !== "object" || content === null) return [];
  const record = content as Readonly<Record<string, unknown>>;
  if (Array.isArray(record.threads)) return record.threads.flatMap(resultThreadIds);
  const key = resultThreadKeys.find((candidate) => typeof record[candidate] === "string");
  return key === undefined ? [] : [record[key] as string];
};

/**
 * Thread ids that received a handoff. The input's `threadId` is used only after
 * the call succeeded, so it is one the handler already resolved and authorized.
 */
const handoffTargetIds = (
  tool: string,
  args: unknown,
  result: McpSchema.CallToolResult | undefined,
): ReadonlyArray<string> => {
  if (!isInputTargetHandoff(tool, args)) return resultThreadIds(result?.structuredContent);
  if (result === undefined || toolOutcome(result).outcome !== "ok") return [];
  const threadId = (args as { readonly threadId?: unknown } | null | undefined)?.threadId;
  return typeof threadId === "string" ? [threadId] : [];
};

/** Tool analytics must never include IDs, prompts or free text. */
export const withToolAnalytics =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* <A, E, R>(registration: Effect.Effect<A, E, R>) {
    const server = yield* McpServer.McpServer;
    const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);
    if (Option.isNone(analytics)) return yield* registration;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
    const shellOf = (threadId: string) =>
      Option.isNone(threads)
        ? Effect.succeed(null)
        : threads.value
            .getThreadShell(ThreadId.make(threadId))
            .pipe(Effect.orElseSucceed(() => null));
    const depthOf =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (thread: AgentThread) {
        let depth = 0;
        let parentId =
          thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null;
        while (parentId !== null && depth < MAX_REPORTED_DEPTH) {
          depth += 1;
          const parent = yield* shellOf(parentId);
          parentId =
            parent?.lineage.relationshipToParent === "subagent"
              ? parent.lineage.parentThreadId
              : null;
        }
        return depth;
      });
    const scheduledRunOf = (threadId: string, runId: RunId | null) =>
      Option.isNone(threads) || runId === null
        ? Effect.succeed(false)
        : threads.value
            .getThreadRecords(ThreadId.make(threadId), ["runs", "messages"], {
              runIds: [runId],
              messageRoles: ["user"],
            })
            .pipe(
              Effect.map((records) => {
                const run = records.runs.find((candidate) => candidate.id === runId);
                return records.messages.some(
                  (message) =>
                    message.id === run?.userMessageId && message.scheduledTaskId !== undefined,
                );
              }),
              Effect.orElseSucceed(() => false),
            );
    const record =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(
        function* (
          tool: string,
          args: unknown,
          result: McpSchema.CallToolResult | undefined,
          durationMs: number,
        ) {
          const handoff =
            HANDOFF_TOOLS.has(tool) ||
            isInputTargetHandoff(tool, args) ||
            hasAction(RESULT_TARGET_ACTIONS, tool, args);
          const outcome = toolOutcome(result);
          if (!handoff && outcome.outcome === "ok") return;
          // Client credentials (no calling thread) report an unknown caller.
          const invocation = Option.getOrUndefined(
            yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
          )?.thread;
          const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
          const caller =
            handoff && invocation !== undefined
              ? ((yield* shellOf(invocation.threadId)) ?? undefined)
              : undefined;
          const targetIds = handoff
            ? [...new Set(handoffTargetIds(tool, args, result))].filter(
                (threadId) => threadId !== invocation?.threadId,
              )
            : [];
          const targets = yield* Effect.forEach(targetIds, shellOf);
          for (const properties of agentToolProperties({
            tool,
            providers,
            caller,
            ...(invocation === undefined
              ? {}
              : { callerProviderInstanceId: invocation.providerInstanceId }),
            ...(caller === undefined || invocation === undefined
              ? {}
              : {
                  callerDepth: yield* depthOf(caller),
                  callerScheduledRun: yield* scheduledRunOf(
                    invocation.threadId,
                    caller.activeRunId,
                  ),
                }),
            targets: targets.filter((thread) => thread !== null),
            outcome,
            ...(handoff
              ? { settings: handoffSettings(tool, args, result?.structuredContent) }
              : {}),
            durationMs,
          })) {
            yield* analytics.value.record("mcp.tool.invoked", properties);
          }
        },
        (effect, _tool, _args, _result, _durationMs) => effect.pipe(Effect.ignoreCause),
      );
    const recordingServer = McpServer.McpServer.of({
      ...server,
      addTool: Effect.fn("McpServer.addTool")(function (options) {
        return server.addTool({
          ...options,
          handle:
            /* Request instrumentation already owns the span; keep this helper in that context. */
            Effect.fnUntraced(function* (payload) {
              const startedAt = yield* Clock.currentTimeMillis;
              return yield* options.handle(payload).pipe(
                Effect.onExit((exit) => {
                  const result = exit._tag === "Success" ? exit.value : undefined;
                  // A call that asks for input is retried with it, and that call is the one counted.
                  if (result instanceof McpSchema.InputRequired) return Effect.void;
                  // Handoff tools look up threads to record; the response must not wait on them.
                  return Clock.currentTimeMillis.pipe(
                    Effect.flatMap((endedAt) =>
                      record(options.tool.name, payload, result, endedAt - startedAt),
                    ),
                    Effect.forkDetach,
                    Effect.asVoid,
                  );
                }),
              );
            }),
        });
      }),
    });
    return yield* registration.pipe(Effect.provideService(McpServer.McpServer, recordingServer));
  });
