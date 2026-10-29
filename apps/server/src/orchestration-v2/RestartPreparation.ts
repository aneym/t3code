import * as ServerSettings from "../serverSettings.ts";
import { releaseClaudeBackgroundWork } from "./Adapters/ClaudeProcessGroup.ts";
import { restartContinuationRun, unacceptedRestartRun } from "./RestartContinuation.ts";
import * as Cause from "effect/Cause";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  ServerPrepareRestartError,
  ServerImportRestartHandoffError,
  type ServerImportRestartHandoffInput,
  type ServerRestartHandoff,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as EffectOutbox from "./EffectOutbox.ts";
import { drainBeforeRestart } from "./RestartDrain.ts";
import { legacyRestartHandoffs } from "./RestartHandoffImport.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const prepareRestart = Effect.fn("ProviderRuntimeRecoveryService.prepareRestart")(
  function* (epoch: string, drainTimeoutMs = 0) {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const preparedEpoch = yield* outbox.restartPrepared;
    if (preparedEpoch !== undefined && preparedEpoch !== epoch)
      return yield* new ServerPrepareRestartError({
        cause: "A different restart epoch is already prepared.",
      });
    const prior = yield* outbox.listByCommandId(CommandId.make(`command:restart-handoff:${epoch}`));
    if (prior.some((effect) => effect.status !== "pending"))
      return yield* new ServerPrepareRestartError({
        cause: "Restart epoch has already been consumed or aborted.",
      });
    const drain =
      preparedEpoch === undefined && drainTimeoutMs > 0
        ? yield* drainBeforeRestart(epoch, Duration.millis(drainTimeoutMs))
        : undefined;
    yield* outbox.prepareRestart(epoch);
    const receipt = yield* Effect.gen(function* () {
      const running = yield* outbox.runningEffects;
      yield* Effect.forEach(running, (effect) => outbox.awaitSettled(effect.id), { discard: true });
      return yield* outbox.withTransaction(
        Effect.gen(function* () {
          const threadIds = yield* projections.getRecoveryThreadIds("runtime");
          const handoffs: ServerRestartHandoff[] = [];
          for (const threadId of threadIds) {
            const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
            const requests = projection.runtimeRequests.filter(
              (request) => request.status === "pending",
            );
            const runIds = projection.runs
              .filter((run) => ["preparing", "starting", "running", "waiting"].includes(run.status))
              .map((run) => run.id);
            handoffs.push({
              threadId,
              runIds,
              sourceRunIds: runIds,
              queuedRunIds: projection.runs
                .filter((run) => run.status === "queued")
                .map((run) => run.id),
              requestIds: requests.map((request) => request.id),
              delegatedTaskIds: projection.subagents
                .filter(
                  (task) =>
                    task.status === "pending" ||
                    task.status === "running" ||
                    task.status === "waiting",
                )
                .map((task) => task.id),
              pausedRunIds: projection.runs
                .filter(
                  (run) =>
                    requests.some(
                      (request) =>
                        request.kind !== "dynamic_tool_call" &&
                        request.kind !== "auth_refresh" &&
                        projection.nodes.some(
                          (node) => node.id === request.nodeId && node.runId === run.id,
                        ),
                    ) ||
                    projection.turnItems.some(
                      (item) =>
                        item.type === "secret_request" &&
                        item.secretStatus === "pending" &&
                        item.runId === run.id,
                    ),
                )
                .map((run) => run.id),
              paused:
                projection.thread.archivedAt !== null ||
                projection.thread.deletedAt !== null ||
                projection.thread.settledOverride === "settled",
            });
          }
          const commandId = CommandId.make(`command:restart-handoff:${epoch}`);
          yield* outbox.enqueue(
            handoffs.map((handoff) => ({
              id: `effect:restart-handoff:${epoch}:${handoff.threadId}`,
              commandId,
              threadId: handoff.threadId,
              request: { type: "provider-runtime.restart-handoff" as const, epoch, handoff },
            })),
          );
          return handoffs;
        }),
      );
    }).pipe(Effect.onError(() => abortRestart(epoch).pipe(Effect.ignore)));
    return {
      epoch,
      ready: true as const,
      threads: receipt,
      ...(drain === undefined ? {} : { drain }),
    };
  },
  (effect) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      return yield* outbox.serializeRestartPrepare(Effect.scoped(effect));
    }).pipe(Effect.mapError((cause) => new ServerPrepareRestartError({ cause }))),
);

export const abortRestart = Effect.fn("RestartPreparation.abortRestart")(
  function* (epoch: string) {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    if ((yield* outbox.restartPrepared) !== epoch)
      return yield* new ServerPrepareRestartError({
        cause: "Restart epoch is not prepared by this process.",
      });
    const handoffs = yield* outbox.restartHandoffs;
    for (const effect of handoffs) {
      if (
        effect.request.type !== "provider-runtime.restart-handoff" ||
        effect.request.epoch !== epoch
      )
        continue;
      const cancelled = yield* outbox.cancelUnsettled({
        threadId: effect.threadId,
        effectTypes: ["provider-runtime.restart-handoff"],
        reason: "Restart aborted before process replacement.",
      });
      yield* outbox.signalCancellations(cancelled);
    }
    yield* outbox.abortRestart(epoch);
    return { epoch, aborted: true as const };
  },
  Effect.mapError((cause) => new ServerPrepareRestartError({ cause })),
);

export const importRestartHandoff = Effect.fn("RestartPreparation.importRestartHandoff")(
  function* (input: ServerImportRestartHandoffInput) {
    const sink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const { handoffs, events } = yield* legacyRestartHandoffs(input);
    const commandId = CommandId.make(`command:restart-handoff:${input.epoch}`);
    yield* sink.writeWithEffects({
      commandId,
      events,
      effects: handoffs.map((handoff) => ({
        id: `effect:restart-handoff:${input.epoch}:${handoff.threadId}`,
        commandId,
        threadId: handoff.threadId,
        request: { type: "provider-runtime.restart-handoff" as const, epoch: input.epoch, handoff },
      })),
    });
    yield* outbox.notifyAvailable();
    return { epoch: input.epoch, ready: true as const, threads: handoffs };
  },
  Effect.mapError((cause) => new ServerImportRestartHandoffError({ cause })),
);
export const prepareForShutdown = Effect.gen(function* () {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
  const prepared = (yield* outbox.restartPrepared) !== undefined;
  const linux = (yield* HostProcess.Platform) === "linux";
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  if (!enabled) return;
  const threadIds = yield* projections.getRecoveryThreadIds("runtime");
  for (const threadId of threadIds) {
    yield* Effect.gen(function* () {
      const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
      if (
        !resolveProjectSettings(enabled, projection.thread.projectId).settings
          .continueThreadsAfterServerUpdate
      )
        return;
      const released = linux ? 0 : releaseClaudeBackgroundWork(threadId);
      if (released > 0)
        yield* Effect.logInfo("Released Claude background work for restart", { threadId });
      if (prepared) return;
      const run = restartContinuationRun(projection) ?? unacceptedRestartRun(projection);
      if (!run) return;
      const commandId = CommandId.make(`command:restart-prepare:${run.id}`);
      yield* eventSink.writeWithEffects({
        commandId,
        events: [],
        effects: [
          {
            id: `effect:restart-continuation:${run.id}`,
            commandId,
            threadId,
            request: { type: "provider-runtime.continue", sourceRunId: run.id },
          },
        ],
      });
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Failed to prepare a restart continuation", { threadId, cause }),
      ),
    );
  }
}).pipe(Effect.mapError((cause) => new ServerPrepareRestartError({ cause })));
