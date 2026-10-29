import {
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitResult,
  type OrchestratorMcpThreadStatus,
  type OrchestratorMcpThreadTimelineItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { printJson, type OwnerMcpTools } from "./ownerMcpTools.ts";
import { ThreadNeedsInputError, ThreadRunEndedError } from "./threadCommon.ts";

const WAIT_SLICE_MS = 15_000;
const READ_PAGE_LIMIT = 100;
export const readTimeline = Effect.fn("cli.thread.readTimeline")(function* (
  tools: OwnerMcpTools,
  threadId: ThreadId,
  view: "messages" | "activity",
) {
  const items: Array<OrchestratorMcpThreadTimelineItem> = [];
  let afterPosition: number | undefined;
  let page: OrchestratorMcpThreadReadResult;
  do {
    page = yield* tools.call(
      "t3_thread_read",
      {
        threadId,
        view,
        limit: READ_PAGE_LIMIT,
        runLimit: 1,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      },
      OrchestratorMcpThreadReadResult,
    );
    items.push(...page.items);
    afterPosition = page.nextPosition ?? undefined;
  } while (page.hasMore && afterPosition !== undefined);
  return { thread: page.thread, items };
});

export const readThreadOnly = Effect.fn("cli.thread.readThreadOnly")(function* (
  tools: OwnerMcpTools,
  threadId: ThreadId,
) {
  const page = yield* tools.call(
    "t3_thread_read",
    { threadId, view: "messages", limit: 1, runLimit: 1 },
    OrchestratorMcpThreadReadResult,
  );
  return { thread: page.thread, items: [] as Array<OrchestratorMcpThreadTimelineItem> };
});

export const readFullText = Effect.fn("cli.thread.readFullText")(function* (
  tools: OwnerMcpTools,
  threadId: ThreadId,
  item: OrchestratorMcpThreadTimelineItem,
) {
  let text = item.text ?? "";
  let nextTextOffset = item.textTruncated ? (item.nextTextOffset ?? null) : null;
  while (nextTextOffset !== null) {
    const page = yield* tools.call(
      "t3_thread_read",
      { threadId, itemId: item.itemId, textOffset: nextTextOffset, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    const chunk = page.items.find((candidate) => candidate.itemId === item.itemId);
    if (chunk === undefined) break;
    text += chunk.text ?? "";
    nextTextOffset = chunk.textTruncated ? (chunk.nextTextOffset ?? null) : null;
  }
  return text;
});

const runResultText = Effect.fn("cli.thread.runResultText")(function* (
  tools: OwnerMcpTools,
  threadId: ThreadId,
  runId: RunId,
  type: "assistant_message" | "error",
) {
  const { items } = yield* readTimeline(
    tools,
    threadId,
    type === "assistant_message" ? "messages" : "activity",
  );
  const item = items.findLast((candidate) => candidate.runId === runId && candidate.type === type);
  return item === undefined ? null : yield* readFullText(tools, threadId, item);
});

type WaitOutcome =
  | {
      readonly type: "ended";
      readonly runId: RunId | null;
      readonly status: OrchestratorMcpThreadStatus;
    }
  | { readonly type: "needs_input" };

export const waitForRun = Effect.fn("cli.thread.waitForRun")(function* (
  tools: OwnerMcpTools,
  threadId: ThreadId,
  runId: RunId,
) {
  const waitSlice = (timeoutMs: number) =>
    tools.call("t3_thread_wait", { threadId, runId, timeoutMs }, OrchestratorMcpThreadWaitResult);
  const ended = (waited: OrchestratorMcpThreadWaitResult) =>
    ({ type: "ended", runId: waited.runId, status: waited.status }) satisfies WaitOutcome;
  while (true) {
    const waited = yield* waitSlice(WAIT_SLICE_MS);
    if (!waited.timedOut) return ended(waited);
    const { thread } = yield* tools.call(
      "t3_thread_read",
      { threadId, limit: 1, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    if (thread.pendingRequestCount > 0) {
      const recheck = yield* waitSlice(1);
      return recheck.timedOut ? ({ type: "needs_input" } satisfies WaitOutcome) : ended(recheck);
    }
  }
});

export const finishRun = Effect.fn("cli.thread.finishRun")(function* (
  tools: OwnerMcpTools,
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly json: boolean;
    readonly extra?: Readonly<Record<string, unknown>>;
  },
) {
  const outcome = yield* waitForRun(tools, input.threadId, input.runId);
  const runId = outcome.type === "ended" ? (outcome.runId ?? input.runId) : input.runId;
  const status = outcome.type === "ended" ? outcome.status : "waiting";
  const reply =
    status === "completed"
      ? yield* runResultText(tools, input.threadId, runId, "assistant_message")
      : null;
  const error =
    status === "completed" || status === "waiting"
      ? null
      : yield* runResultText(tools, input.threadId, runId, "error");
  if (input.json) {
    yield* printJson({ threadId: input.threadId, runId, status, reply, error, ...input.extra });
  } else if (reply !== null) {
    yield* Console.log(reply);
  }
  if (outcome.type === "needs_input") {
    return yield* new ThreadNeedsInputError({ threadId: input.threadId });
  }
  if (status !== "completed") {
    return yield* new ThreadRunEndedError({
      threadId: input.threadId,
      status,
      ...(error === null ? {} : { error }),
    });
  }
});
