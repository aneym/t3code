import { RegistryContext } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { useContext, useEffect } from "react";

import { environmentThreads } from "../state/threads";
import { resolveThreadRouteTarget } from "../threadRoutes";

export function useEmbedNavigationPrefetch(): void {
  const router = useRouter();
  const registry = useContext(RegistryContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts loading the next thread when the router begins navigating, before its view renders
  useEffect(() => {
    let mounted: { readonly key: string; readonly release: () => void } | null = null;
    const release = () => {
      mounted?.release();
      mounted = null;
    };
    const unsubscribe = router.subscribe("onBeforeNavigate", (event) => {
      if (!event.pathChanged) return;
      const params = router.matchRoutes(event.toLocation).at(-1)?.params;
      const target = params ? resolveThreadRouteTarget(params) : null;
      if (target?.kind !== "server") return release();
      const { environmentId, threadId } = target.threadRef;
      const key = `${environmentId}:${threadId}`;
      if (mounted?.key === key) return;
      release();
      const atom = environmentThreads.stateAtom(environmentId, threadId);
      mounted = { key, release: registry.mount(atom) };
    });
    return () => {
      unsubscribe();
      release();
    };
  }, [router, registry]);
}
