import type {
  DesktopPreviewTabState,
  PreviewNavStatus,
  PreviewReportStatusInput,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { recordFaviconForThread } from "~/browserFaviconStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { acquireBrowserSurfaceActivity } from "~/browser/browserSurfaceStore";
import { isGuardRefusal, recordNativeTabFailure } from "~/browser/nativeTabFailures";
import {
  applyPreviewDesktopState,
  type DesktopPreviewOverlay,
  readThreadPreviewState,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Keeps a hidden guest painting behind the app while the desktop host captures it; Electron
 * composites no offscreen guest, so its screenshot or stream would otherwise never finish.
 */
export function createCaptureActivity(tabId: string) {
  let release: (() => void) | null = null;
  const update = (capturing: boolean) => {
    if (capturing && !release) release = acquireBrowserSurfaceActivity(tabId);
    else if (!capturing && release) {
      release();
      release = null;
    }
  };
  return { update, release: () => update(false) };
}

/** ElectronBrowserHost owns webview lifetime. */
export function usePreviewBridge(input: {
  threadRef: ScopedThreadRef;
  tabId: string;
  runtimeTabId: string;
  serverDriven?: boolean;
  mirrored?: boolean;
  guarded?: boolean;
}): void {
  const {
    threadRef,
    tabId,
    runtimeTabId,
    serverDriven = false,
    mirrored = false,
    guarded = false,
  } = input;
  const clearBrowserPointer = useBrowserPointerStore((state) => state.clear);
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus, "preview status report");
  const { environmentId, threadId } = threadRef;
  const stableThreadRef: ScopedThreadRef = { environmentId, threadId };

  const lastReportedUrl = useRef<string | null>(null);
  const lastReportedKind = useRef<DesktopPreviewTabState["navStatus"]["kind"] | null>(null);
  const lastDesktopNavStatus = useRef<DesktopPreviewTabState["navStatus"] | null>(null);
  const captureActivity = useRef<ReturnType<typeof createCaptureActivity> | null>(null);
  const handleStateChange = useEffectEvent(
    (changedTabId: string, state: DesktopPreviewTabState): void => {
      if (changedTabId !== runtimeTabId) return;
      if (shouldClearBrowserPointer(lastDesktopNavStatus.current, state.navStatus)) {
        clearBrowserPointer(runtimeTabId);
      }
      lastDesktopNavStatus.current = state.navStatus;
      captureActivity.current?.update(state.capturing);
      applyPreviewDesktopState(stableThreadRef, tabId, projectDesktopState(state, mirrored));
      const serverStatus =
        guarded && state.navStatus.kind === "LoadFailed" && isGuardRefusal(state.navStatus.code)
          ? readThreadPreviewState(stableThreadRef).sessions[tabId]?.navStatus
          : undefined;
      if (serverStatus !== undefined && serverStatus._tag !== "Idle") {
        recordNativeTabFailure(environmentId, tabId, serverStatus.url);
      }
      if (state.favicon) {
        recordFaviconForThread(stableThreadRef, state.favicon);
      }
      const reported = buildReportInput({
        threadId: stableThreadRef.threadId,
        tabId,
        state,
        lastReportedUrl: lastReportedUrl.current,
        lastReportedKind: lastReportedKind.current,
      });
      if (!reported || serverDriven || mirrored) return;
      lastReportedUrl.current = reported.lastReportedUrl;
      lastReportedKind.current = reported.lastReportedKind;
      void reportStatus({
        environmentId: stableThreadRef.environmentId,
        input: reported.input,
      });
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to preview bridge state changes and capture activity for the current tab
  useEffect(() => {
    if (!previewBridge || typeof window === "undefined") return;
    lastReportedUrl.current = null;
    lastReportedKind.current = null;
    lastDesktopNavStatus.current = null;
    const activity = createCaptureActivity(runtimeTabId);
    captureActivity.current = activity;
    const unsubscribe = previewBridge.onStateChange(handleStateChange);
    return () => {
      unsubscribe();
      activity.release();
      if (captureActivity.current === activity) captureActivity.current = null;
    };
  }, [
    runtimeTabId,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A different tab or thread starts its status reports and pointer tracking from scratch.
    environmentId,
    threadId,
    tabId,
  ]);
}

function shouldClearBrowserPointer(
  previous: DesktopPreviewTabState["navStatus"] | null,
  current: DesktopPreviewTabState["navStatus"],
): boolean {
  if (!previous) return false;
  if (current.kind === "Loading" && previous.kind !== "Loading") return true;
  if (current.kind === "Idle" || previous.kind === "Idle") return false;
  return current.url !== previous.url;
}

function toNavStatus(status: DesktopPreviewTabState["navStatus"]): PreviewNavStatus {
  if (status.kind === "Idle") return { _tag: "Idle" };
  if (status.kind !== "LoadFailed") {
    return { _tag: status.kind, url: status.url, title: status.title };
  }
  const { url, title, code, description } = status;
  return { _tag: "LoadFailed", url, title, code, description };
}

export function projectDesktopState(
  state: DesktopPreviewTabState,
  mirrored = false,
): DesktopPreviewOverlay {
  const navOrigin = state.navStatus.kind === "Idle" ? null : originOf(state.navStatus.url);
  return {
    ...(mirrored ? { navStatus: toNavStatus(state.navStatus) } : {}),
    hasWebContents: state.webContentsId !== null,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.navStatus.kind === "Loading",
    zoomFactor: state.zoomFactor,
    pictureInPicture: state.pictureInPicture,
    colorScheme: state.colorScheme,
    audioMuted: state.audioMuted,
    audible: state.audible,
    controller: state.controller,
    favicon: state.favicon && originOf(state.favicon.pageUrl) === navOrigin ? state.favicon : null,
  };
}

function buildReportInput(args: {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly state: DesktopPreviewTabState;
  readonly lastReportedUrl: string | null;
  readonly lastReportedKind: DesktopPreviewTabState["navStatus"]["kind"] | null;
}): {
  readonly input: PreviewReportStatusInput;
  readonly lastReportedUrl: string;
  readonly lastReportedKind: DesktopPreviewTabState["navStatus"]["kind"];
} | null {
  const { threadId, tabId, state, lastReportedUrl, lastReportedKind } = args;
  const status = state.navStatus;
  if (status.kind === "Idle") return null;

  const sameAsLast =
    status.kind !== "LoadFailed" &&
    status.kind === lastReportedKind &&
    status.url === lastReportedUrl;
  if (sameAsLast) return null;

  return {
    input: {
      threadId,
      tabId,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
      navStatus: toNavStatus(status),
    },
    lastReportedUrl: status.url,
    lastReportedKind: status.kind,
  };
}
