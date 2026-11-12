import type {
  ModelSelection,
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import type { CommandRunWindow } from "./CommandRunWindow.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";

const commandFields: ReadonlyArray<ProjectionRecordField> = [
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
];

const commandFilter: ProjectionRecordFilter = {
  turnItemTypes: ["user_message", "error", "run_interrupt_request"],
  messageRoles: ["user"],
  omitSettledLeafNodes: true,
  // Commands here read only undelivered or active tasks; a dispatcher thread keeps
  // thousands of delivered ones, each carrying its full prompt.
  omitSettledSubagents: true,
};

const openRunStatuses = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const maxWidenings = 3;

type CommandRecords = Effect.Success<ReturnType<ProjectionStoreV2Shape["getThreadRecords"]>>;

const unloadedRunIds = (records: CommandRecords, runId: (ordinal: number) => RunId) => {
  const prefix = runId(0)
    .slice(0, -1)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const loaded = new Set<string>(records.runs.map((run) => run.id));
  const scanned = JSON.stringify(
    [
      records.thread,
      records.runs,
      records.attempts,
      records.nodes,
      records.subagents,
      records.messages,
      records.turnItems,
      records.providerTurns,
      records.runtimeRequests.filter((request) => request.status === "pending"),
    ],
    (key, value) => (key === "text" ? undefined : value),
  );
  const missing = new Set<RunId>();
  for (const match of scanned.matchAll(new RegExp(`${prefix}(\\d+)`, "g"))) {
    const id = runId(Number(match[1]));
    if (!loaded.has(id)) missing.add(id);
  }
  return [...missing];
};

export const readCommandRecords = Effect.fn("CommandProjectionRead.read")(function* (
  store: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  threadId: ThreadId,
  runId: (ordinal: number) => RunId,
  windowed: boolean,
) {
  const read = (runWindow?: CommandRunWindow) =>
    store.getThreadRecords(
      threadId,
      commandFields,
      runWindow === undefined ? commandFilter : { ...commandFilter, runWindow },
    );
  if (!windowed) return yield* read();
  const runIds: Array<RunId> = [];
  for (let widening = 0; widening < maxWidenings; widening++) {
    const records = yield* read({ runIds: [...runIds] });
    if (records.messages.every(isNativeMaintenanceCommand)) return yield* read();
    const missing = unloadedRunIds(records, runId).filter((id) => !runIds.includes(id));
    if (missing.length === 0) return records;
    runIds.push(...missing);
  }
  return yield* read();
});

export const windowsCommandProjection = (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
) =>
  command.delegatedCompletion === undefined &&
  command.notification === undefined &&
  command.sourcePlanRef === undefined &&
  command.manualContinuationOfRunId === undefined &&
  command.usageLimitContinuationOfRunId === undefined &&
  command.restartContinuationOfRunId === undefined;

export const commandNeedsFullHistory = (
  projection: OrchestrationV2ThreadProjection,
  requested: ModelSelection | undefined,
) => {
  const { thread } = projection;
  const selection = requested ?? thread.modelSelection;
  const activeProviderThread = projection.providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  return (
    thread.historyOrigin === "v1_import" ||
    !modelSelectionsEqual(thread.modelSelection, selection) ||
    (activeProviderThread !== undefined &&
      activeProviderThread.providerInstanceId !== selection.instanceId) ||
    projection.runs.some(
      (run) =>
        openRunStatuses.has(run.status) && !modelSelectionsEqual(run.modelSelection, selection),
    ) ||
    projection.contextTransfers.some(
      (transfer) =>
        (transfer.type === "fork" || transfer.type === "merge_back") &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    )
  );
};
