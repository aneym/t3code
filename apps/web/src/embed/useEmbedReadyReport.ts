import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect } from "react";

import { useEnvironmentThread } from "../state/threads";
import { postToEmbedHost } from "./embedHost";
import { EMBED_READY_MESSAGE } from "./embedProtocol";

export function useEmbedReadyReport(threadRef: ScopedThreadRef | null, threadId: string): void {
  const thread = useEnvironmentThread(
    threadRef?.environmentId ?? null,
    threadRef?.threadId ?? null,
  );
  const settled =
    threadRef === null ||
    Option.isSome(thread.data) ||
    Option.isSome(thread.error) ||
    thread.status === "deleted";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the host each thread it routes to has drawn
  useEffect(() => {
    if (settled) postToEmbedHost({ type: EMBED_READY_MESSAGE, threadId });
  }, [settled, threadId]);
}
