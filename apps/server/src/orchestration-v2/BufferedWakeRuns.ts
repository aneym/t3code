import type { OrchestrationV2Run, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isBufferedProviderNotification } from "./NotificationMailbox.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

export const bufferedWakeRuns = Effect.fn("BufferedWakeRuns.read")(function* (
  projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  threadId: ThreadId,
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  const queued = runs.filter((run) => run.status === "queued");
  if (queued.length === 0) return [];
  const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
    messageIds: queued.map((run) => run.userMessageId),
  });
  const buffered = new Set(
    messages.filter(isBufferedProviderNotification).map((message) => message.id),
  );
  return queued.filter((run) => buffered.has(run.userMessageId));
});
