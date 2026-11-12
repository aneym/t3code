import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useLayoutEffect, useState } from "react";

import { useEnvironmentThread } from "../state/threads";
import { useEmbedHostConnected } from "./embedHost";
import { createEmbedReadyWatch } from "./embedReadyWatch";

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
  const drawsRows = Option.exists(
    thread.data,
    (data) => data.messages.length > 0 || data.turnItems.length > 0,
  );
  const connected = useEmbedHostConnected();
  const router = useRouter();
  const [watch] = useState(createEmbedReadyWatch);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- notes the rows on screen before each navigation, so ready waits for the next thread's own rows
  useEffect(() => {
    const unsubscribe = router.subscribe("onBeforeNavigate", (event) => {
      if (event.pathChanged) watch.navigating();
    });
    return () => {
      unsubscribe();
      watch.stop();
    };
  }, [router, watch]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the host in the commit that draws the routed thread's first rows
  useLayoutEffect(() => {
    if (connected) watch.report(threadId, settled, drawsRows);
  }, [watch, connected, threadId, settled, drawsRows]);
}
