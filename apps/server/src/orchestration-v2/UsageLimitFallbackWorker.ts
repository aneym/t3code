import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RunFallback,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import { poolFailureDetail, poolResetAt } from "../provider/poolExhaustion.ts";
import { probePoolHeadroom } from "../provider/poolHeadroom.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import {
  decideFallback,
  type ExhaustedProvider,
  FallbackStep,
  type PoolState,
  stepIndex,
} from "./ModelFallbackChain.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { fallbackMessageId, RUN_LOCAL_MODEL_MESSAGE_PREFIX } from "./runLocalModelSelection.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const FALLBACK_CHAIN_FILE = "model-fallback-chain.json";

const QUOTA_NOTICE =
  /^\W{0,4}(individual quota reached|rate limit exceeded until|you have reached your [\w\s]{0,40}quota|resource_exhausted)/i;
const QUOTA_TAIL =
  /\n\W{0,4}(individual quota reached\.[^\n]{0,200}resets in (\d+[hms])+\.?|rate limit exceeded until \S+ \(in \d+s\))\s*$/i;
const OVERLOADED = /^api_error_5(03|29)$|overloaded/i;
const MAX_NOTICE_CHARS = 600;
const HANDLED_LIMIT = 2_000;

const FallbackChainFile = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  chain: Schema.Array(FallbackStep),
});
const decodeChainFile = Schema.decodeUnknownEffect(Schema.fromJsonString(FallbackChainFile));

type Items = OrchestrationV2ThreadProjection["turnItems"];

interface Outage {
  readonly reason: OrchestrationV2RunFallback["reasonKind"];
  readonly resetsAt?: string | undefined;
}

function runOutage(runId: OrchestrationV2Run["id"], items: Items, nowMs: number): Outage | null {
  const own = items.filter((item) => item.runId === runId);
  for (const item of own) {
    if (item.type !== "error" || item.retry !== undefined) continue;
    const { failure } = item;
    const resetsAt =
      failure.resetAt ?? poolResetAt(`${failure.message}\n${failure.code ?? ""}`, nowMs);
    if (
      poolFailureDetail(
        `${failure.message}\n${failure.code ?? ""}`,
        failure.code === "api_error_503" ? 503 : null,
        nowMs,
      ) !== undefined
    ) {
      return { reason: "no_accounts", resetsAt };
    }
    if (failure.class === "usage_limit") return { reason: "limit", resetsAt };
    if (failure.class === "provider_error" && OVERLOADED.test(failure.code ?? failure.message)) {
      return { reason: "outage", resetsAt };
    }
  }
  const last = own.filter((item) => item.type === "assistant_message").at(-1);
  if (last === undefined || last.type !== "assistant_message") return null;
  const text = last.text.trim();
  return (text.length <= MAX_NOTICE_CHARS && QUOTA_NOTICE.test(text)) || QUOTA_TAIL.test(last.text)
    ? { reason: "limit", resetsAt: poolResetAt(text, nowMs) }
    : null;
}

const outageReason = (from: FallbackStep, outage: Outage) =>
  `${from.label} was ${outage.reason === "outage" ? "down" : "out of quota"}`;

const exhaustedNotice = (providers: ReadonlyArray<ExhaustedProvider>) =>
  `No model is free for this turn, so it stopped. ${providers
    .map(
      (provider) =>
        `${provider.label}: ${provider.resetsAt === undefined ? "reset time unknown" : `resets ${provider.resetsAt}`}.`,
    )
    .join(" ")}`;

const previousRunId = (messageId: string) =>
  messageId.startsWith(RUN_LOCAL_MODEL_MESSAGE_PREFIX)
    ? messageId.slice(RUN_LOCAL_MODEL_MESSAGE_PREFIX.length)
    : undefined;

const isFinished = (
  event: OrchestrationV2DomainEvent,
): event is Extract<OrchestrationV2DomainEvent, { type: "run.updated" }> =>
  event.type === "run.updated" &&
  (event.payload.status === "completed" || event.payload.status === "failed") &&
  event.payload.completedAt !== null;

const makeHandler = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const instances = yield* Effect.serviceOption(ProviderInstanceRegistry);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const chainPath = path.join(stateDir, FALLBACK_CHAIN_FILE);
  const handled = new Set<string>();

  const readChain = fileSystem.readFileString(chainPath).pipe(
    Effect.flatMap(decodeChainFile),
    Effect.map((file) => (file.enabled === false ? [] : file.chain)),
    Effect.orElseSucceed((): ReadonlyArray<FallbackStep> => []),
  );

  const configuredInstances = Option.match(instances, {
    onNone: () => Effect.undefined,
    onSome: (registry) =>
      registry.listInstances.pipe(
        Effect.map((list) => new Set<string>(list.map((instance) => instance.instanceId))),
      ),
  });

  const seriesOutages = Effect.fn("UsageLimitFallbackWorker.seriesOutages")(function* (
    run: OrchestrationV2Run,
    outage: Outage,
    nowMs: number,
  ) {
    const outages = new Map<string, Outage>([[run.modelSelection.instanceId, outage]]);
    const { runs } = yield* projections.getThreadRecords(run.threadId, ["runs"]);
    const series: Array<OrchestrationV2Run> = [];
    let cursor = previousRunId(run.userMessageId);
    while (cursor !== undefined && series.length < 8) {
      const earlier = runs.find((candidate) => candidate.id === cursor);
      if (earlier === undefined) break;
      series.push(earlier);
      cursor = previousRunId(earlier.userMessageId);
    }
    if (series.length === 0) return outages;
    const { turnItems } = yield* projections.getThreadRecords(run.threadId, ["turnItems"], {
      turnItemRunIds: series.map((earlier) => earlier.id),
    });
    for (const earlier of series) {
      const found = runOutage(earlier.id, turnItems, nowMs);
      if (found !== null && !outages.has(earlier.modelSelection.instanceId)) {
        outages.set(earlier.modelSelection.instanceId, found);
      }
    }
    return outages;
  });

  return Effect.fn("UsageLimitFallbackWorker.handle")(function* (run: OrchestrationV2Run) {
    if (handled.has(run.id)) return;
    const chain = yield* readChain;
    if (stepIndex(chain, run.modelSelection) < 0) return;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const records = yield* projections.getThreadRecords(run.threadId, ["turnItems", "messages"], {
      turnItemRunIds: [run.id],
      messageIds: [run.userMessageId],
    });
    const outage = runOutage(run.id, records.turnItems, nowMs);
    if (outage === null) return;
    const thread = records.thread;
    const original = records.messages.find((message) => message.id === run.userMessageId);
    if (thread.archivedAt != null || original === undefined || original.role !== "user") return;
    const personChat =
      original.createdBy !== "system" &&
      original.senderThreadId === undefined &&
      original.linkedSender === undefined &&
      original.scheduledTaskId === undefined;
    const outages = yield* seriesOutages(run, outage, nowMs);
    const headroom = yield* probePoolHeadroom;
    const configured = yield* configuredInstances;
    const pool = (step: FallbackStep): PoolState | undefined => {
      const failed = outages.get(step.modelSelection.instanceId);
      return failed === undefined
        ? headroom(step.modelSelection.instanceId)
        : { exhausted: true, resetsAt: failed.resetsAt };
    };
    const decision = decideFallback({
      chain,
      run: run.modelSelection,
      stored: thread.modelSelection,
      personChat,
      allowed: (step) => configured === undefined || configured.has(step.modelSelection.instanceId),
      pool,
    });
    if (decision.type === "none") return;
    handled.add(run.id);
    if (handled.size > HANDLED_LIMIT) handled.delete(handled.values().next().value!);
    if (decision.type === "exhausted") {
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`quota-exhausted-note:${run.id}`),
        messageId: MessageId.make(`quota-exhausted:${run.id}`),
        threadId: run.threadId,
        text: exhaustedNotice(decision.providers),
        attachments: [],
        dispatchMode: { type: "note" },
        createdBy: "system",
        creationSource: "server",
      });
      yield* Effect.logWarning("orchestration-v2.quota-fallback.exhausted", {
        threadId: run.threadId,
        runId: run.id,
        providers: decision.providers,
      });
      return;
    }
    const { from, to } = decision;
    const reason = outageReason(from, outage);
    const fallback: OrchestrationV2RunFallback = {
      fromProvider: run.modelSelection.instanceId,
      fromModel: run.modelSelection.model,
      toProvider: to.modelSelection.instanceId,
      toModel: to.modelSelection.model,
      reasonKind: outage.reason,
      reason,
      resetsAt: outage.resetsAt ?? null,
      at: DateTime.formatIso(now),
    };
    const isRetry = original.id.startsWith(RUN_LOCAL_MODEL_MESSAGE_PREFIX);
    const text = isRetry ? original.text.slice(original.text.indexOf("\n\n") + 2) : original.text;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`quota-fallback-resend:${run.id}`),
      messageId: MessageId.make(fallbackMessageId(run.id)),
      threadId: run.threadId,
      text: `Fallback model (${to.label} — potential lower quality than ${from.label}): ${reason}.\n\n${text}`,
      attachments: original.attachments,
      ...(original.context === undefined ? {} : { context: original.context }),
      ...(original.senderThreadId === undefined ? {} : { senderThreadId: original.senderThreadId }),
      modelSelection: to.modelSelection,
      fallback,
      dispatchMode: { type: "queue_after_active" },
      createdBy: original.createdBy,
      creationSource: "server",
    });
    yield* Effect.logInfo("orchestration-v2.quota-fallback.resent", {
      threadId: run.threadId,
      runId: run.id,
      from: from.label,
      to: to.label,
      reason,
    });
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const handle = yield* makeHandler;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        isFinished(event)
          ? handle(event.payload).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.quota-fallback.failed", {
                  runId: event.payload.id,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ),
    );
  }),
);
