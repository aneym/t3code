import {
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitResult,
  type OrchestratorMcpThreadRun,
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
const WAKE_GRACE_MS = 10_000;
const WAKE_POLL_MS = 500;
const TERMINAL_RUN_STATUSES = new Set<OrchestratorMcpThreadRun["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);
const READ_PAGE_LIMIT = 100;
const READ_ITEM_MAX_CHARS = 20_000;
const readTimeline = Effect.fn("cli.thread.readTimeline")(function* (
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
        maxCharsPerItem: READ_ITEM_MAX_CHARS,
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

/**
 * The latest `count` user and assistant messages, oldest first. Positions
 * count every timeline item, so the read starts near the end and widens
 * backward only while tool and plan items leave too few messages.
 */
export const readLatestMessages = Effect.fn("cli.thread.readLatestMessages")(function* (
  tools: OwnerMcpTools,
  threadId: ThreadId,
  count: number,
) {
  let { thread } = yield* tools.call(
    "t3_thread_read",
    { threadId, limit: 1, runLimit: 1 },
    OrchestratorMcpThreadReadResult,
  );
  let messages: Array<OrchestratorMcpThreadTimelineItem> = [];
  // The newest window has no upper bound, so items added since the first
  // read are still shown.
  let before: number | undefined;
  let start = thread.itemCount;
  let span = Math.max(count, READ_PAGE_LIMIT);
  do {
    const end = before;
    start = Math.max(0, start - span);
    const window: Array<OrchestratorMcpThreadTimelineItem> = [];
    let afterPosition = start - 1;
    let page: OrchestratorMcpThreadReadResult;
    do {
      page = yield* tools.call(
        "t3_thread_read",
        {
          threadId,
          view: "messages",
          limit: READ_PAGE_LIMIT,
          maxCharsPerItem: READ_ITEM_MAX_CHARS,
          runLimit: 1,
          ...(afterPosition < 0 ? {} : { afterPosition }),
        },
        OrchestratorMcpThreadReadResult,
      );
      window.push(
        ...page.items.filter(
          (item) =>
            (item.type === "user_message" || item.type === "assistant_message") &&
            (end === undefined || item.position < end),
        ),
      );
      afterPosition = page.nextPosition ?? Number.POSITIVE_INFINITY;
    } while (page.hasMore && afterPosition < (end ?? Number.POSITIVE_INFINITY) - 1);
    thread = page.thread;
    // A window can hold the whole --messages count, too many to spread as arguments.
    messages = window.concat(messages);
    before = start;
    span *= 2;
  } while (messages.length < count && start > 0);
  return { thread, messages: messages.slice(Math.max(0, messages.length - count)) };
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
      {
        threadId,
        itemId: item.itemId,
        textOffset: nextTextOffset,
        runLimit: 1,
        maxCharsPerItem: READ_ITEM_MAX_CHARS,
      },
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

export const threadIsIdle = Effect.fn("cli.thread.threadIsIdle")(function* (
  tools: OwnerMcpTools,
  threadId: ThreadId,
) {
  const waited = yield* tools.call(
    "t3_thread_wait",
    { threadId, timeoutMs: 1, untilDelegatedWorkSettled: true },
    OrchestratorMcpThreadWaitResult,
  );
  return !waited.timedOut;
});

const runsAfter = Effect.fn("cli.thread.runsAfter")(function* (
  tools: OwnerMcpTools,
  threadId: ThreadId,
  runId: RunId,
) {
  const { recentRuns } = yield* tools.call(
    "t3_thread_read",
    { threadId, limit: 1, runLimit: 50 },
    OrchestratorMcpThreadReadResult,
  );
  const own = recentRuns.find((run) => run.runId === runId);
  if (own === undefined) return { later: [], sent: true };
  const later = recentRuns.filter((run) => run.ordinal > own.ordinal);
  if (later.length === 0) return { later, sent: false };
  const { items } = yield* readTimeline(tools, threadId, "messages");
  const sent = items.some(
    (item) => item.type === "user_message" && later.some((run) => run.runId === item.runId),
  );
  return { later, sent };
});

export const waitForRun = Effect.fn("cli.thread.waitForRun")(function* (
  tools: OwnerMcpTools,
  threadId: ThreadId,
  runId: RunId,
  followWakes = false,
) {
  const waitSlice = (timeoutMs: number, untilDelegatedWorkSettled?: true) =>
    tools.call(
      "t3_thread_wait",
      {
        threadId,
        runId,
        timeoutMs,
        ...(untilDelegatedWorkSettled ? { untilDelegatedWorkSettled } : {}),
      },
      OrchestratorMcpThreadWaitResult,
    );
  const ended = (waited: OrchestratorMcpThreadWaitResult) =>
    ({ type: "ended", runId: waited.runId, status: waited.status }) satisfies WaitOutcome;
  const ownRun = Effect.gen(function* () {
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
  const outcome = yield* ownRun;
  if (!followWakes || outcome.type !== "ended" || outcome.status !== "completed") return outcome;
  const finalRunId = outcome.runId ?? runId;
  const wakeRunRecorded = Effect.gen(function* () {
    for (let waited = 0; waited < WAKE_GRACE_MS; waited += WAKE_POLL_MS) {
      yield* Effect.sleep(WAKE_POLL_MS);
      const after = yield* runsAfter(tools, threadId, finalRunId);
      if (after.sent) return false;
      if (after.later.length > 0) return true;
    }
    return false;
  });
  let workOutlivedRun = false;
  while (true) {
    const waited = yield* waitSlice(WAIT_SLICE_MS, true);
    const result = waited.timedOut ? undefined : waited.resultRun;
    const after = yield* runsAfter(tools, threadId, finalRunId);
    if (after.sent) return outcome;
    if (!waited.timedOut) {
      if (result !== undefined && after.later.some((run) => run.runId === result.runId)) {
        return { type: "ended", runId: result.runId, status: result.status } satisfies WaitOutcome;
      }
      if (!workOutlivedRun) return outcome;
      if (after.later.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) continue;
      if (after.later.length === 0 && (yield* wakeRunRecorded)) continue;
      return outcome;
    }
    workOutlivedRun = true;
    const { thread } = yield* tools.call(
      "t3_thread_read",
      { threadId, limit: 1, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    if (thread.pendingRequestCount > 0) return { type: "needs_input" } satisfies WaitOutcome;
  }
});

export const finishRun = Effect.fn("cli.thread.finishRun")(function* (
  tools: OwnerMcpTools,
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly json: boolean;
    readonly followWakes?: boolean;
    readonly extra?: Readonly<Record<string, unknown>>;
    readonly includeRun?: boolean;
  },
) {
  const outcome = yield* waitForRun(tools, input.threadId, input.runId, input.followWakes);
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
  const run = input.includeRun
    ? (yield* tools.call(
        "t3_thread_read",
        { threadId: input.threadId, limit: 1, runLimit: 1 },
        OrchestratorMcpThreadReadResult,
      )).recentRuns.find((candidate) => candidate.runId === runId)
    : undefined;
  if (input.json) {
    yield* printJson({
      threadId: input.threadId,
      runId,
      status,
      reply,
      error,
      ...input.extra,
      ...(run === undefined ? {} : { run }),
    });
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
