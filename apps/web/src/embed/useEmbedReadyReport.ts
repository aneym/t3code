import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useLayoutEffect, useState } from "react";

import { useEnvironmentThread } from "../state/threads";
import { useEmbedHostConnected } from "./embedHost";
import { embedPaintSource } from "./embedPaintSource";
import { createEmbedReadyWatch } from "./embedReadyWatch";

export function useEmbedReadyReport(
  threadRef: ScopedThreadRef | null,
  threadId: string,
  held = false,
): void {
  const thread = useEnvironmentThread(
    threadRef?.environmentId ?? null,
    threadRef?.threadId ?? null,
  );
  const settled =
    !held &&
    (threadRef === null ||
      Option.isSome(thread.data) ||
      Option.isSome(thread.error) ||
      thread.status === "deleted");
  const drawsRows = Option.exists(
    thread.data,
    (data) => data.messages.length > 0 || data.turnItems.length > 0,
  );
  const shown = held ? null : embedPaintSource(thread);
  const [first, setFirst] = useState(() => ({ threadId, from: shown }));
  const stale = first.threadId !== threadId || (first.from === null && shown !== null);
  if (stale) setFirst({ threadId, from: shown });
  const from = (stale ? shown : first.from) ?? "live";
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
    if (connected) watch.report(threadId, settled, drawsRows, from);
  }, [watch, connected, threadId, settled, drawsRows, from]);
}
