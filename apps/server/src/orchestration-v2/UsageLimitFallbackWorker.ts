import {
  CommandId,
  MessageId,
  ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { RUN_LOCAL_MODEL_MESSAGE_PREFIX } from "./runLocalModelSelection.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const FALLBACK_CHAIN_FILE = "model-fallback-chain.json";

const QUOTA_NOTICE =
  /^\W{0,4}(individual quota reached|rate limit exceeded until|you have reached your [\w\s]{0,40}quota|resource_exhausted)/i;
const MAX_NOTICE_CHARS = 600;
const HANDLED_LIMIT = 2_000;

const FallbackStep = Schema.Struct({
  label: Schema.String,
  modelSelection: ModelSelection,
  personChatOnly: Schema.optional(Schema.Boolean),
});
type FallbackStep = typeof FallbackStep.Type;

const FallbackChainFile = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  chain: Schema.Array(FallbackStep),
});
const decodeChainFile = Schema.decodeUnknownEffect(Schema.fromJsonString(FallbackChainFile));

type Items = OrchestrationV2ThreadProjection["turnItems"];

const stepIndex = (
  chain: ReadonlyArray<FallbackStep>,
  selected: Pick<OrchestrationV2Run, "modelSelection">,
) =>
  chain.findIndex(
    (step) =>
      step.modelSelection.instanceId === selected.modelSelection.instanceId &&
      step.modelSelection.model === selected.modelSelection.model,
  );

function nextFallbackStep(
  chain: ReadonlyArray<FallbackStep>,
  run: Pick<OrchestrationV2Run, "modelSelection">,
  personChat: boolean,
): { readonly at: number; readonly from: FallbackStep; readonly to: FallbackStep } | null {
  const at = stepIndex(chain, run);
  if (at < 0) return null;
  const to = chain
    .slice(at + 1)
    .find(
      (step) =>
        step.modelSelection.instanceId !== run.modelSelection.instanceId &&
        (personChat || step.personChatOnly !== true),
    );
  return to === undefined ? null : { at, from: chain[at]!, to };
}

function endedOnUsageLimit(runId: OrchestrationV2Run["id"], items: Items): boolean {
  const own = items.filter((item) => item.runId === runId);
  if (
    own.some(
      (item) =>
        item.type === "error" && item.failure.class === "usage_limit" && item.retry === undefined,
    )
  ) {
    return true;
  }
  const replies = own.filter((item) => item.type === "assistant_message");
  const last = replies.at(-1);
  return (
    last !== undefined &&
    last.type === "assistant_message" &&
    last.text.length <= MAX_NOTICE_CHARS &&
    QUOTA_NOTICE.test(last.text.trim())
  );
}

const fallbackNotice = (from: FallbackStep, to: FallbackStep) =>
  `${from.label} hit its usage limit, so this message runs on ${to.label}.`;

const isFinished = (
  event: OrchestrationV2DomainEvent,
): event is Extract<OrchestrationV2DomainEvent, { type: "run.updated" }> =>
  event.type === "run.updated" &&
  (event.payload.status === "completed" || event.payload.status === "failed") &&
  event.payload.completedAt !== null;

const makeHandler = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
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

  return Effect.fn("UsageLimitFallbackWorker.handle")(function* (run: OrchestrationV2Run) {
    if (handled.has(run.id)) return;
    const chain = yield* readChain;
    if (stepIndex(chain, run) < 0) return;
    const records = yield* projections.getThreadRecords(run.threadId, ["turnItems", "messages"], {
      turnItemRunIds: [run.id],
      messageIds: [run.userMessageId],
    });
    if (!endedOnUsageLimit(run.id, records.turnItems)) return;
    const thread = records.thread;
    const original = records.messages.find((message) => message.id === run.userMessageId);
    if (thread.archivedAt != null || original === undefined || original.role !== "user") return;
    const personChat =
      original.createdBy !== "system" &&
      original.senderThreadId === undefined &&
      original.linkedSender === undefined &&
      original.scheduledTaskId === undefined;
    const step = nextFallbackStep(chain, run, personChat);
    if (step === null) return;
    const storedAt = stepIndex(chain, thread);
    if (storedAt < 0 || storedAt > step.at) return;
    const isRetry = original.id.startsWith(RUN_LOCAL_MODEL_MESSAGE_PREFIX);
    const text = isRetry ? original.text.slice(original.text.indexOf("\n\n") + 2) : original.text;
    handled.add(run.id);
    if (handled.size > HANDLED_LIMIT) handled.delete(handled.values().next().value!);
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`quota-fallback-resend:${run.id}`),
      messageId: MessageId.make(`${RUN_LOCAL_MODEL_MESSAGE_PREFIX}${run.id}`),
      threadId: run.threadId,
      text: `${fallbackNotice(step.from, step.to)}\n\n${text}`,
      attachments: original.attachments,
      ...(original.context === undefined ? {} : { context: original.context }),
      ...(original.senderThreadId === undefined ? {} : { senderThreadId: original.senderThreadId }),
      modelSelection: step.to.modelSelection,
      dispatchMode: { type: "queue_after_active" },
      createdBy: original.createdBy,
      creationSource: "server",
    });
    yield* Effect.logInfo("orchestration-v2.quota-fallback.resent", {
      threadId: run.threadId,
      runId: run.id,
      from: step.from.label,
      to: step.to.label,
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
