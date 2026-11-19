import {
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2GetThreadHistoryPageInput,
  type OrchestrationV2GetTurnItemInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";

const MIN_HISTORY_PAGE_BYTES = 32_768;
const MAX_HISTORY_PAGE_BYTES = 1_048_576;

const readFailed = (threadId: OrchestrationV2GetTurnItemInput["threadId"], message: string) =>
  Effect.mapError(
    (cause) => new OrchestrationV2GetThreadProjectionError({ threadId, message, cause }),
  );

export const getTurnItemRpc = (
  threadManagement: ThreadManagementServiceShape,
  input: OrchestrationV2GetTurnItemInput,
) =>
  threadManagement.getTurnItem(input).pipe(readFailed(input.threadId, "Failed to load turn item"));

export const getThreadHistoryPageRpc = (
  threadManagement: ThreadManagementServiceShape,
  input: OrchestrationV2GetThreadHistoryPageInput,
) =>
  threadManagement
    .getThreadHistoryPage(
      input.threadId,
      input.cursor,
      input.throughEntryId,
      input.view === "conversation",
      input.view === "work" ? "work" : input.deferWork === true ? "deferred" : undefined,
      input.maxBytes === undefined
        ? undefined
        : Math.min(Math.max(input.maxBytes, MIN_HISTORY_PAGE_BYTES), MAX_HISTORY_PAGE_BYTES),
    )
    .pipe(
      Effect.map((page) =>
        input.compactIds === true ? { ...page, idTable: true as const } : page,
      ),
      readFailed(input.threadId, "Failed to load earlier history"),
    );
