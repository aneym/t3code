import type { ProviderTurnId, RunId } from "@t3tools/contracts";

import { type CommandRunWindow, runWindow } from "./CommandRunWindow.ts";
import type { ProjectionRecordField, ProjectionRecordFilter } from "./ProjectionStore.ts";

export const COMMAND_PROJECTION_FIELDS = [
  "runs",
  "attempts",
  "nodes",
  "subagents",
  "providerSessions",
  "providerThreads",
  "providerTurns",
  "runtimeRequests",
  "messages",
  "turnItems",
  "checkpointScopes",
  "contextTransfers",
] as const satisfies ReadonlyArray<ProjectionRecordField>;

export const commandProjectionFilter = (recent?: CommandRunWindow): ProjectionRecordFilter => ({
  turnItemTypes: ["user_message", "error", "run_interrupt_request"],
  messageRoles: ["user"],
  omitSettledLeafNodes: true,
  omitSettledSubagents: true,
  omitSettledSubagentRecords: true,
  contextTransferStatuses: ["pending"],
  ...(recent === undefined ? {} : { recentRuns: recent }),
});

export const queuedRunStartWindow = (options?: {
  readonly failedRunId?: RunId;
  readonly endedRunId?: RunId;
  readonly queuedRunId?: RunId;
}) =>
  runWindow([options?.endedRunId, options?.failedRunId, options?.queuedRunId], {
    deliveryRuns: true,
  });

const OPEN_BACKGROUND_ITEMS: ProjectionRecordFilter = {
  turnItemTypes: [
    "command_execution",
    "dynamic_tool",
    "subagent",
    "assistant_message",
    "reasoning",
  ],
  turnItemStatuses: ["pending", "running", "waiting"],
};

export const RUN_INTERRUPT_FIELDS = [
  "runs",
  "nodes",
  "providerThreads",
  "providerTurns",
  "messages",
  "attempts",
  "turnItems",
  "subagents",
  "runtimeRequests",
] as const satisfies ReadonlyArray<ProjectionRecordField>;

export const runInterruptFilter = (runId: RunId): ProjectionRecordFilter => ({
  ...OPEN_BACKGROUND_ITEMS,
  omitSettledLeafNodes: true,
  recentRuns: runWindow([runId], { openItemRuns: true, deliveryRuns: true }),
});

export const BACKGROUND_SETTLE_FIELDS = [
  "runs",
  "attempts",
  "nodes",
  "subagents",
  "runtimeRequests",
  "turnItems",
  "providerThreads",
] as const satisfies ReadonlyArray<ProjectionRecordField>;

export const backgroundSettleFilter = (providerTurnId: ProviderTurnId): ProjectionRecordFilter => ({
  ...OPEN_BACKGROUND_ITEMS,
  recentRuns: runWindow([], { openItemRuns: true, providerTurnId }),
});

export const THREAD_SETTLE_FILTER: ProjectionRecordFilter = {
  runStatuses: ["queued", "preparing", "starting", "running", "waiting"],
  newestRuns: 1,
  runtimeRequestStatuses: ["pending"],
};
