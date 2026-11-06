import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewNavStatus, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import { isGuardRefusal } from "~/browser/nativeTabFailures";
import { guardsPreviewTab } from "~/browser/previewRuntime";
import { remoteDeviceAccess } from "~/browser/remoteDeviceAccess";
import { toastManager } from "~/components/ui/toast";
import { previewStateAtom, type ThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { type ClosePreviewSessionInput, closePreviewSession } from "./closePreviewSession";

type SettledNavStatus = Extract<PreviewNavStatus, { _tag: "Success" | "LoadFailed" }>;

function settledNavStatus(
  threadRef: ScopedThreadRef,
  tabId: string,
): Promise<SettledNavStatus | null> {
  return new Promise((resolve) => {
    let seen = false;
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const settle = (status: SettledNavStatus | null) => {
      settled = true;
      unsubscribe?.();
      resolve(status);
    };
    const check = (state: ThreadPreviewState) => {
      if (settled) return;
      const status = state.sessions[tabId]?.navStatus;
      if (status === undefined) {
        if (seen) settle(null);
        return;
      }
      seen = true;
      if (status._tag === "Success" || status._tag === "LoadFailed") settle(status);
    };
    unsubscribe = appAtomRegistry.subscribe(previewStateAtom(scopedThreadKey(threadRef)), check, {
      immediate: true,
    });
    if (settled) unsubscribe();
  });
}

export async function finishPreviewTabMove<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly from: PreviewSessionSnapshot;
  readonly to: PreviewSessionSnapshot;
  readonly closePreview: ClosePreviewSessionInput<E>["closePreview"];
}): Promise<void> {
  const { threadRef, from, to, closePreview } = input;
  useRightPanelStore.getState().openBrowser(threadRef, to.tabId);
  const guarded =
    to.runtime === "desktop" &&
    from.navStatus._tag !== "Idle" &&
    guardsPreviewTab(
      threadRef.environmentId,
      appAtomRegistry.get(primaryEnvironmentIdAtom),
      remoteDeviceAccess(),
    );
  const status = guarded ? await settledNavStatus(threadRef, to.tabId) : null;
  if (guarded && status?._tag !== "Success") {
    if (status === null) return;
    useRightPanelStore.getState().openBrowser(threadRef, from.tabId);
    await closePreviewSession({ closePreview, snapshot: null, tabId: to.tabId, threadRef });
    toastManager.add({
      type: "error",
      title: "Kept the remote browser tab",
      description: isGuardRefusal(status.code)
        ? `Remote tabs on this computer open only public addresses, so it can't reach ${URL.parse(status.url)?.host ?? status.url}.`
        : status.description,
    });
    return;
  }
  await closePreviewSession({ closePreview, snapshot: from, tabId: from.tabId, threadRef });
}
