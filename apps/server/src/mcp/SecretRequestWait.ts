import {
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  SECRET_REQUEST_UNSAVED_NOTE,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { secretOwnerChain } from "../orchestration-v2/SecretRequestRecord.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { awaitServerFreeze } from "../serverHandoffBarrier.ts";

export const reenterSecretCard = (
  records: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  runId: RunId,
  turnItemId: TurnItemId,
) => {
  const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
  if (item === undefined) return "new";
  if (
    item.type !== "secret_request" ||
    item.runId === null ||
    !secretOwnerChain(records.runs, runId).has(item.runId)
  )
    return "conflict";
  return item.secretStatus === "pending"
    ? item.runId === runId
      ? "wait"
      : "rebind"
    : item.secretStatus;
};

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

export const awaitSecretAnswer = Effect.fn("SecretRequestWait.awaitSecretAnswer")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly turnItemId: TurnItemId;
    readonly key: string;
    readonly request: OrchestratorMcpRequestSecretInput;
    readonly initialStatus?: "saved" | "declined" | "cancelled";
    readonly closeCard: Effect.Effect<void>;
  }): Effect.fn.Return<
    OrchestratorMcpRequestSecretResult,
    OrchestratorMcpFailure,
    ThreadManagementService.ThreadManagementService | SecretRequests.SecretRequests
  > {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const secrets = yield* SecretRequests.SecretRequests;
    const records = threads
      .getThreadRecords(input.threadId, ["runs", "turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError(() => failure("Unable to read the secret request.")));
    const answered =
      input.initialStatus === undefined
        ? yield* Effect.gen(function* () {
            while (true) {
              const projection = yield* records;
              const item = projection.turnItems.find(
                (candidate) => candidate.id === input.turnItemId,
              );
              if (item?.type === "secret_request" && item.secretStatus !== "pending")
                return item.secretStatus;
              const current = projection.runs.find((candidate) => candidate.id === input.runId);
              if (
                current === undefined ||
                ThreadManagementService.isTerminalRunStatus(current.status)
              ) {
                yield* input.closeCard;
                return "cancelled" as const;
              }
              yield* Effect.sleep(Duration.millis(500));
            }
          }).pipe(
            Effect.raceFirst(awaitServerFreeze(true).pipe(Effect.as("restarting" as const))),
            Effect.timeoutOption(
              Duration.millis(Math.min(input.request.timeoutMs ?? 600_000, 3_600_000)),
            ),
            Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : input.closeCard)),
          )
        : Option.some(input.initialStatus);
    if (Option.isNone(answered)) yield* input.closeCard;
    const status = Option.isSome(answered)
      ? answered.value
      : yield* records.pipe(
          Effect.map((projection) => {
            const item = projection.turnItems.find(
              (candidate) => candidate.id === input.turnItemId,
            );
            return item?.type === "secret_request" &&
              (item.secretStatus === "saved" || item.secretStatus === "declined")
              ? item.secretStatus
              : ("timed_out" as const);
          }),
          Effect.orElseSucceed(() => "timed_out" as const),
        );
    yield* Effect.annotateCurrentSpan({ "secret_request.status": status });
    yield* Metrics.increment(Metrics.secretRequestsTotal, { status });
    if (status === "restarting") return { status, clientRequestId: input.key };
    if (status !== "saved") return { status, note: SECRET_REQUEST_UNSAVED_NOTE[status] };
    if (input.request.delivery === "file") {
      const file = yield* secrets
        .saveToFile(input)
        .pipe(Effect.mapError((error) => failure(error.message)));
      return { status, file };
    }
    const ref = yield* secrets.savedRef(input);
    if (Option.isNone(ref))
      return yield* failure(
        "The user saved the secret, but it could not be read. Ask again with a new clientRequestId.",
      );
    return { status, secretRef: ref.value };
  },
);
