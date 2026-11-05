import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  applyPreviewServerEvent,
  previewStateAtom,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";
import { environmentCatalog } from "~/connection/catalog";
import { isElectron } from "~/env";
import { previewEnvironment } from "~/state/preview";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

class PreviewSessionThreadKeyParseError extends Schema.TaggedError<PreviewSessionThreadKeyParseError>()(
  "PreviewSessionThreadKeyParseError",
  { threadKey: Schema.String },
) {
  override get message(): string {
    return `Invalid scoped preview thread key: ${this.threadKey}`;
  }
}

const previewSessionSyncAtom = Atom.family((threadKey: string) => {
  const threadRef = parseScopedThreadKey(threadKey);
  if (threadRef === null) {
    throw new PreviewSessionThreadKeyParseError({ threadKey });
  }

  const sessionsAtom = previewEnvironment.list({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });
  const eventsAtom = previewEnvironment.events({
    environmentId: threadRef.environmentId,
    input: {},
  });

  return Atom.make((get) => {
    let disposed = false;
    let eventsVersion = 0;

    const reconcileSessions = (result: Atom.Type<typeof sessionsAtom>) => {
      if (result.waiting || !AsyncResult.isSuccess(result)) return;
      reconcilePreviewServerSessions(threadRef, result.value);
      if (!readThreadPreviewState(threadRef).listLoaded) {
        // An event overtook the initial list; retry before using the partial index for surface cleanup.
        queueMicrotask(() => {
          if (!disposed) get.refresh(sessionsAtom);
        });
      }
    };

    const applyLatestEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (!AsyncResult.isSuccess(result) || result.value.threadId !== threadRef.threadId) return;
      const currentEpoch = readThreadPreviewState(threadRef).serverEpoch;
      if (currentEpoch !== null && currentEpoch !== result.value.serverEpoch) {
        get.refresh(sessionsAtom);
        return;
      }
      applyPreviewServerEvent(threadRef, result.value);
    };

    get.addFinalizer(() => {
      disposed = true;
    });
    const initialEvent = get.once(eventsAtom);
    // Evaluate the lazy list, then reconcile only new responses because cached results can be stale.
    get.once(sessionsAtom);
    get.subscribe(sessionsAtom, (result) => {
      reconcileSessions(result);
    });
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyLatestEvent(result);
    });
    get.mount(sessionsAtom);
    get.mount(eventsAtom);
    queueMicrotask(() => {
      if (disposed) return;
      // Keep local tabs until authoritative refresh; stale cached emptiness could remove automation-created
      // tabs.
      const current = get.once(sessionsAtom);
      if (!AsyncResult.isInitial(current) && !current.waiting) get.refresh(sessionsAtom);
      if (eventsVersion === 0) applyLatestEvent(initialEvent);
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`preview:session-sync:${threadKey}`));
});

export function usePreviewSession(threadRef: ScopedThreadRef): void {
  useAtomValue(previewSessionSyncAtom(scopedThreadKey(threadRef)));
}

const inactiveAtom = Atom.make(() => undefined);

// Discover background tabs without listing every thread at startup. Keep each
// sync while the thread has tabs so later events still arrive while chat is
// absent, then release it so closed previews stop costing a list and a fan-out.
const remoteDeviceThreadKeys = new Set<string>();

export function isRemoteDeviceThread(threadKey: string): boolean {
  return remoteDeviceThreadKeys.has(threadKey);
}

const desktopHostedPreviewSyncAtom = Atom.family((key: string) => {
  const [environmentId, device] = key.split("\u0000") as [EnvironmentId, string];
  const eventsAtom = previewEnvironment.events({ environmentId, input: {} });
  return Atom.make((get) => {
    const releaseByThreadId = new Map<string, () => void>();
    get.addFinalizer(() => {
      for (const release of releaseByThreadId.values()) release();
    });
    get.subscribe(
      eventsAtom,
      (result) => {
        if (!AsyncResult.isSuccess(result) || result.value.type === "closed") return;
        if (
          device !== "" &&
          !("snapshot" in result.value && result.value.snapshot.device === device)
        )
          return;
        const threadId = result.value.threadId;
        if (releaseByThreadId.has(threadId)) return;
        const threadKey = scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));
        if (device !== "") remoteDeviceThreadKeys.add(threadKey);
        const unmount = get.registry.mount(previewSessionSyncAtom(threadKey));
        // The opening event may not be applied yet, so wait until a tab has
        // been seen. A pending local close can still be cancelled and restored.
        let hadSessions = false;
        const unwatch = get.registry.subscribe(
          previewStateAtom(threadKey),
          (state) => {
            if (Object.keys(state.sessions).length > 0) hadSessions = true;
            else if (hadSessions && state.suppressedTabIds.size === 0) release();
          },
          { immediate: true },
        );
        function release() {
          if (device !== "") remoteDeviceThreadKeys.delete(threadKey);
          unwatch();
          unmount();
          releaseByThreadId.delete(threadId);
        }
        releaseByThreadId.set(threadId, release);
      },
      { immediate: true },
    );
  }).pipe(Atom.withLabel(`preview:desktop-hosted-sync:${key}`));
});

const remoteDeviceTabSyncAtom = Atom.family((device: string) =>
  Atom.make((get) => {
    const primary = get(primaryEnvironmentIdAtom);
    for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
      if (entry.enabled && environmentId !== primary)
        get(desktopHostedPreviewSyncAtom(`${environmentId}\u0000${device}`));
    }
  }).pipe(Atom.withLabel(`preview:remote-device-tab-sync:${device}`)),
);

export function useDesktopHostedPreviewSessions(environmentId: EnvironmentId | null): void {
  useAtomValue(
    isElectron && environmentId !== null
      ? desktopHostedPreviewSyncAtom(`${environmentId}\u0000`)
      : inactiveAtom,
  );
}

export function useRemoteDeviceTabSessions(device: string | null): void {
  useAtomValue(isElectron && device !== null ? remoteDeviceTabSyncAtom(device) : inactiveAtom);
}
