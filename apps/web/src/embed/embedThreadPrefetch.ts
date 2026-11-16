import type { AtomRegistry } from "effect/reactivity";

import type { AppRouter } from "../router";
import { environmentThreads } from "../state/threads";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { isEmbedPath } from "./embedProtocol";

let release: (() => void) | null = null;

export function startEmbedThreadPrefetch(
  router: AppRouter,
  registry: AtomRegistry.AtomRegistry,
): void {
  const { location } = router.state;
  if (!isEmbedPath(location.pathname)) return;
  const target = resolveThreadRouteTarget(router.matchRoutes(location).at(-1)?.params ?? {});
  if (target?.kind !== "server") return;
  const { environmentId, threadId } = target.threadRef;
  release = registry.mount(environmentThreads.stateAtom(environmentId, threadId));
}

export function releaseEmbedThreadPrefetch(): void {
  release?.();
  release = null;
}
