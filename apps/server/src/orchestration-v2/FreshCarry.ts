import {
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { renderHistory } from "@t3tools/provider-core/server/handoffBudget";
import * as Config from "effect/Config";

import { contextBoundaryOrdinal, isHandoffSourceRun } from "./ContextBoundary.ts";
import { selectThreadHistory } from "./ContextHandoffService.ts";

export const DEFAULT_CHILD_ROLL_TOKENS = 120_000;
export const childRollTokensConfig = Config.Int("T3CODE_CHILD_ROLL_TOKENS").pipe(
  Config.withDefault(DEFAULT_CHILD_ROLL_TOKENS),
  Config.map((value) => Math.max(0, value)),
);

const ROLL_AFTER_RUNS_WITHOUT_USAGE = 8;
const BUSY_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const ENDED_SUBAGENT_STATUSES: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const MAX_BRIEF_CHARS = 12_000;
const MAX_LISTED = 20;
const PAYLOAD_JSON_CAP = 64_000;

const isOpenSubagent = (subagent: Pick<OrchestrationV2Subagent, "status">) =>
  !ENDED_SUBAGENT_STATUSES.has(subagent.status);

export function runsSinceFreshStart(
  runs: ReadonlyArray<OrchestrationV2Run>,
): ReadonlyArray<OrchestrationV2Run> {
  const boundary = contextBoundaryOrdinal(runs);
  return runs
    .filter((run) => run.ordinal >= boundary && isHandoffSourceRun(run))
    .toSorted((left, right) => left.ordinal - right.ordinal);
}

export function threadHasPendingWork(input: {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "pendingBackgroundTasks">
  >;
  readonly subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>;
}): boolean {
  return (
    input.runs.some((run) => BUSY_RUN_STATUSES.has(run.status)) ||
    input.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0) ||
    input.subagents.some(isOpenSubagent)
  );
}

export function childRollDue(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource">;
  readonly runsSinceFreshStart: number;
  readonly usedTokens: number | undefined;
  readonly compacted: boolean;
  readonly rollTokens: number;
}): boolean {
  if (
    input.rollTokens <= 0 ||
    input.thread.lineage.relationshipToParent !== "subagent" ||
    isProviderNativeSubagentThread(input.thread) ||
    input.runsSinceFreshStart === 0
  )
    return false;
  if (input.compacted) return true;
  return input.usedTokens === undefined
    ? input.runsSinceFreshStart >= ROLL_AFTER_RUNS_WITHOUT_USAGE
    : input.usedTokens > input.rollTokens;
}

const oneLine = (text: string, max = 160) => {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

const listed = <T>(entries: ReadonlyArray<T>, render: (entry: T) => string) =>
  entries.length === 0
    ? "- none"
    : [
        ...entries.slice(0, MAX_LISTED).map((entry) => `- ${render(entry)}`),
        ...(entries.length > MAX_LISTED ? [`- and ${entries.length - MAX_LISTED} more`] : []),
      ].join("\n");

function fitPayload(text: string): string {
  const encoded = JSON.stringify(text).length;
  if (encoded <= PAYLOAD_JSON_CAP) return text;
  const keep = Math.floor((text.length * (PAYLOAD_JSON_CAP - 200)) / encoded);
  return `${text.slice(0, keep)}\n[Carry truncated; read the rest with t3_thread_read.]`;
}

export function renderFreshCarry(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id">;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly brief?: { readonly preamble: string; readonly text: string };
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly budget: number;
}): string {
  const first = input.runs.at(0);
  const last = input.runs.at(-1);
  const history =
    first === undefined || last === undefined
      ? "No earlier turns since the last fresh start."
      : (() => {
          const { selected } = selectThreadHistory({
            threadId: input.thread.id,
            coveredRunOrdinals: { from: first.ordinal, to: last.ordinal },
            runs: input.runs,
            items: input.items,
            budget: input.budget,
          });
          return renderHistory(selected.messages, selected.context);
        })();
  const brief =
    input.brief === undefined
      ? []
      : [
          "Your brief, as your lead first sent it:",
          [
            ...(input.brief.text.startsWith(input.brief.preamble) ? [] : [input.brief.preamble]),
            input.brief.text.length <= MAX_BRIEF_CHARS
              ? input.brief.text
              : `${input.brief.text.slice(0, MAX_BRIEF_CHARS)}\n[Brief truncated; read run 1 with t3_thread_read.]`,
          ].join("\n\n"),
        ];
  return fitPayload(
    [
      `This thread now runs in a fresh provider session. It keeps its thread id, worktree and task; the earlier session is summarized here. Read more with t3_thread_read on thread ${input.thread.id}.`,
      ...brief,
      `Earlier session:\n${history}`,
      `Open child tasks:\n${listed(
        input.subagents.filter(isOpenSubagent),
        (task) =>
          `${oneLine(task.title ?? task.prompt)} (task ${task.id}${task.childThreadId === null ? "" : `, thread ${task.childThreadId}`}, ${task.status})`,
      )}`,
      `Pending background work:\n${listed(
        input.pendingBackgroundTasks,
        (task) =>
          `${task.kind}: ${oneLine(task.description ?? task.command ?? task.taskId)} (${task.taskId})`,
      )}`,
    ].join("\n\n"),
  );
}
