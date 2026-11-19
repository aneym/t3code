import { RegistryContext } from "@effect/atom-react";
import {
  EMBED_ROUTE_REFUSED_MESSAGE,
  EMBED_WARM_LIMIT,
  EnvironmentId,
  ThreadId,
  type EmbedRouteRefusal,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect } from "react";

import { environmentShell } from "../state/shell";
import { environmentThreads } from "../state/threads";
import { channelForSpot, fromEmbedHost, postToEmbedHost } from "./embedHost";
import { readEmbedLocation } from "./embedLocation";
import { repeatEmbedReady } from "./embedReadyWatch";
import { startEmbedRouteTimings } from "./embedRouteTimings";
import {
  embedThreadVisibility,
  planEmbedRoute,
  readEmbedRouteMessage,
  readEmbedWarmMessage,
} from "./embedRouting";
import { createEmbedWarmSet } from "./embedWarmSet";

export function useEmbedRouting(
  origin: string,
  framed: boolean,
  environmentId: string,
  threadId: string | null,
): void {
  const router = useRouter();
  const registry = useContext(RegistryContext);
  const environment = EnvironmentId.make(environmentId);
  const threadState = (thread: string) =>
    environmentThreads.stateAtom(environment, ThreadId.make(thread));
  const warmSet = createEmbedWarmSet(
    EMBED_WARM_LIMIT,
    (thread) => registry.mount(threadState(thread)),
    (thread) => {
      const state = registry.get(threadState(thread));
      return AsyncResult.isSuccess(state) && state.value.history.expanded;
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shown thread's subscription in the warm set so a later route back paints from memory
  useEffect(() => {
    if (threadId !== null) warmSet.show(threadId);
  }, [warmSet, threadId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for the host's route and warm messages and owns the warm subscriptions for the frame's lifetime
  useEffect(() => {
    const shellEnvironment = EnvironmentId.make(environmentId);
    const releaseShell = registry.mount(environmentShell.stateAtom(shellEnvironment));
    const channel = channelForSpot({ origin, framed });
    const visibility = () =>
      embedThreadVisibility(
        registry.get(environmentShell.stateValueAtom(shellEnvironment)).snapshot,
      );
    const refuse = (thread: string, reason: EmbedRouteRefusal) =>
      postToEmbedHost({ type: EMBED_ROUTE_REFUSED_MESSAGE, thread, reason });
    const route = (thread: string) => {
      const current = readEmbedLocation(router.state.location.pathname)?.threadId ?? null;
      const plan = planEmbedRoute(thread, current, visibility());
      if (plan.kind === "refused") return refuse(thread, plan.reason);
      if (plan.kind === "same") return repeatEmbedReady(thread);
      startEmbedRouteTimings(thread);
      warmSet.show(thread);
      void router.navigate({
        to: "/embed/$environmentId/$threadId",
        params: { environmentId, threadId: thread },
        search: true,
        replace: true,
      });
    };
    const onMessage = (event: MessageEvent) => {
      if (!fromEmbedHost(channel, event)) return;
      const routeMessage = readEmbedRouteMessage(event.data);
      if (Option.isSome(routeMessage)) return void route(routeMessage.value.thread);
      const warmMessage = readEmbedWarmMessage(event.data);
      if (Option.isNone(warmMessage)) return;
      const visible = visibility();
      if (visible !== null) warmSet.warm(warmMessage.value.threads.filter(visible));
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      warmSet.clear();
      releaseShell();
    };
  }, [router, registry, warmSet, origin, framed, environmentId]);
}
