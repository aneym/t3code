import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useLayoutEffect, useState } from "react";

import { useEnvironmentThread } from "../state/threads";
import { useEmbedHostConnected } from "./embedHost";
import { readEmbedLocation } from "./embedLocation";
import { embedPaintSource } from "./embedPaintSource";
import { embedParentThreadId } from "./embedParentThread";
import { createEmbedReadyWatch } from "./embedReadyWatch";
import { markEmbedRouteStep } from "./embedRouteTimings";

export function useEmbedReadyReport(
  threadRef: ScopedThreadRef | null,
  threadId: string,
  held = false,
): boolean {
  const refEnvironmentId = threadRef?.environmentId ?? null;
  const refThreadId = threadRef?.threadId ?? null;
  const thread = useEnvironmentThread(refEnvironmentId, refThreadId);
  const settled =
    !held &&
    (threadRef === null ||
      Option.isSome(thread.data) ||
      Option.isSome(thread.error) ||
      thread.status === "deleted");
  const unavailable =
    threadRef !== null &&
    !held &&
    Option.isNone(thread.data) &&
    (Option.isSome(thread.error) || thread.status === "deleted");
  const key = threadRef !== null && Option.isSome(thread.data) ? scopedThreadKey(threadRef) : null;
  const refused = held || unavailable;
  const shown = held ? null : embedPaintSource(thread);
  const [first, setFirst] = useState(() => ({ threadId, from: shown }));
  const stale =
    first.threadId !== threadId ||
    (first.from === null && shown !== null) ||
    (first.from === "live" && shown === "kept");
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
    const unsubscribeLoad = router.subscribe("onLoad", (event) => {
      const routed = readEmbedLocation(event.toLocation.pathname)?.threadId;
      if (routed) markEmbedRouteStep(routed, "navigate");
    });
    return () => {
      unsubscribe();
      unsubscribeLoad();
      watch.stop();
    };
  }, [router, watch]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the host in the commit that draws the routed thread's first rows
  useLayoutEffect(() => {
    if (settled && !unavailable) markEmbedRouteStep(threadId, "mounted");
    if (!connected) return;
    if (refused) {
      watch.refuse(threadId);
      return;
    }
    if (!settled) {
      watch.stop();
      return;
    }
    const parentThreadId =
      refEnvironmentId === null || refThreadId === null
        ? undefined
        : embedParentThreadId(scopeThreadRef(refEnvironmentId, refThreadId));
    watch.report(threadId, key, from, parentThreadId);
  }, [
    watch,
    connected,
    threadId,
    refused,
    unavailable,
    refEnvironmentId,
    refThreadId,
    settled,
    key,
    from,
  ]);
  return unavailable;
}
