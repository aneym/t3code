import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";
import { MobileDatabase } from "../persistence/mobile-database";
import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";

let openThreadCacheKey: string | null = null;
let refreshProtection: (() => void) | undefined;

export function getOpenThreadCacheKey(): string | null {
  return openThreadCacheKey;
}

export function setOpenThreadCacheKey(key: string | null): void {
  openThreadCacheKey = key;
  refreshProtection?.();
}

export function installThreadCacheProtection(): () => void {
  const refresh = () => {
    void runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* MobileDatabase;
        const loaded = appAtomRegistry.get(threadOutboxManager.loadedAtom);
        const protectedThreadKeys = new Set(
          Object.entries(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
            .filter(([, messages]) => messages.length > 0)
            .map(([key]) => key),
        );
        if (openThreadCacheKey !== null) protectedThreadKeys.add(openThreadCacheKey);
        yield* database.setThreadCacheProtection({ loaded, protectedThreadKeys });
      }).pipe(Effect.catch(() => Effect.void)),
    );
  };
  refreshProtection = refresh;
  const stopLoaded = appAtomRegistry.subscribe(threadOutboxManager.loadedAtom, refresh, {
    immediate: true,
  });
  const stopQueued = appAtomRegistry.subscribe(
    threadOutboxManager.queuedMessagesByThreadKeyAtom,
    refresh,
  );
  return () => {
    stopLoaded();
    stopQueued();
    refreshProtection = undefined;
  };
}
