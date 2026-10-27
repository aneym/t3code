import { appAtomRegistry } from "./atom-registry";
import { runtime } from "../lib/runtime";
import { MobileDatabase } from "../persistence/mobile-database";
import * as Effect from "effect/Effect";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { expoThreadOutboxStorage, flushThreadOutboxWrites } from "./thread-outbox-storage";

export * from "./thread-outbox-model";

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
});

let openThreadCacheKey: string | null = null;

export function getOpenThreadCacheKey(): string | null {
  return openThreadCacheKey;
}

function refreshThreadCacheProtection(): void {
  const loaded = appAtomRegistry.get(threadOutboxManager.loadedAtom);
  if (!loaded) return;
  const protectedThreadKeys = new Set(
    Object.entries(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
      .filter(([, messages]) => messages.length > 0)
      .map(([key]) => key),
  );
  if (openThreadCacheKey !== null) protectedThreadKeys.add(openThreadCacheKey);
  void runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* MobileDatabase;
      yield* database.setThreadCacheProtection({ loaded: true, protectedThreadKeys });
    }).pipe(Effect.catch(() => Effect.void)),
  );
}

export function setOpenThreadCacheKey(key: string | null): void {
  openThreadCacheKey = key;
  refreshThreadCacheProtection();
}

appAtomRegistry.subscribe(threadOutboxManager.loadedAtom, refreshThreadCacheProtection);
appAtomRegistry.subscribe(
  threadOutboxManager.queuedMessagesByThreadKeyAtom,
  refreshThreadCacheProtection,
);

/** Drain queued mutations too; optimistic publication precedes the durable file write. */
export async function flushThreadOutbox(): Promise<void> {
  await threadOutboxManager.serialize(async () => {});
  await flushThreadOutboxWrites();
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.enqueue(message);
}

export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.confirmQueued(message);
}

/** Returns false if removed or if expectedRevision differs from threadOutboxRevision; otherwise rewrites the message. */
export function updateThreadOutboxMessage(
  message: QueuedThreadMessage,
  expectedRevision?: number,
): Promise<boolean> {
  return threadOutboxManager.update(message, expectedRevision);
}

export function threadOutboxRevision(messageId: QueuedThreadMessage["messageId"]): number {
  return threadOutboxManager.revisionOf(messageId);
}

// Removal needs draft-state ownership to release files; keep that dependency outside this module.
