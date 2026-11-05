import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type DesktopPreviewBridge,
  type DesktopPreviewOpenLinkEvent,
  type EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  REMOTE_DEVICE_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { type ComponentProps, useState } from "react";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

import { isElectron } from "~/env";
import { subscribeClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import {
  useDesktopHostedPreviewSessions,
  useRemoteDeviceTabSessions,
} from "~/components/preview/usePreviewSession";
import {
  readActivePreviewSessions,
  subscribeActivePreviewSessions,
  type ThreadPreviewState,
  useActivePreviewSessions,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserDefaults } from "./browserDefaults";
import { useBrowserPointerStore } from "./browserPointerStore";
import { onDesktopTabCreated, withDesktopTab } from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { openUrlInPreview } from "./openFileInPreview";
import {
  isLocalPreviewEnvironment,
  rendersServerTabNatively,
  serverDrivesNativeTab,
} from "./previewRuntime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
import { startRemoteBrowserRelays } from "./remoteBrowserRelay";
import {
  type RemoteDeviceAccessFor,
  remoteDeviceAccessFor,
  useRemoteDeviceAccess,
  useRemoteDeviceAccessFor,
} from "./remoteDeviceAccess";
import { resolveRemoteTabUrl } from "./remoteTabUrl";

type HostedBrowserSession = ReturnType<typeof hostedBrowserSessions>[number];

function remoteTabUrls({ threadRef, snapshot, remote, driven }: HostedBrowserSession) {
  const serverUrl = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
  const remoteUrl =
    remote && serverUrl !== null ? resolveRemoteTabUrl(threadRef.environmentId, serverUrl) : null;
  const mirrored = remote && !driven;
  return { serverUrl, remoteUrl, mirrored, mirrorUrl: mirrored ? remoteUrl : null };
}

/** Every session this window renders as a hosted webview, in a fixed (non-display) order. */
function hostedBrowserSessions(
  previewByThreadKey: Record<string, ThreadPreviewState>,
  primaryEnvironmentId: EnvironmentId | null,
  accessFor: RemoteDeviceAccessFor,
) {
  const activeSessions = Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef
      ? Object.values(previewState.sessions)
          .map((snapshot) => ({
            snapshot,
            remote: !isLocalPreviewEnvironment(threadRef.environmentId, primaryEnvironmentId),
          }))
          .filter(
            ({ snapshot, remote }) =>
              (!remote && snapshot.runtime !== "server") ||
              rendersServerTabNatively(
                threadRef.environmentId,
                primaryEnvironmentId,
                snapshot,
                accessFor,
              ),
          )
          .map(({ snapshot, remote }) => ({
            threadRef,
            snapshot,
            remote,
            driven:
              snapshot.runtime === "server" &&
              serverDrivesNativeTab(
                threadRef.environmentId,
                primaryEnvironmentId,
                snapshot,
                accessFor,
              ),
            runtimeTabId: previewRuntimeTabId(threadRef, previewState.serverEpoch, snapshot.tabId),
            pictureInPicture:
              previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
            zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
          }))
      : [];
  });
  // Electron destroys a moved webview's guest, so the render order must not follow the server's
  // updatedAt order. Any fixed order works; this one is not a display order.
  return activeSessions.toSorted((left, right) =>
    left.runtimeTabId < right.runtimeTabId ? -1 : left.runtimeTabId > right.runtimeTabId ? 1 : 0,
  );
}

function startAnnotationThemeSync(preview: DesktopPreviewBridge): () => void {
  let lastSerializedTheme = "";
  const syncTheme = () => {
    const theme = readPreviewAnnotationTheme();
    const serializedTheme = JSON.stringify(theme);
    if (serializedTheme === lastSerializedTheme) return;
    lastSerializedTheme = serializedTheme;
    void preview.setAnnotationTheme(theme).catch(() => {
      lastSerializedTheme = "";
    });
  };
  // App services start before the first paint, when the theme styles may not be applied yet.
  const frameId = window.requestAnimationFrame(syncTheme);
  const observer = new MutationObserver(syncTheme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  const headObserver = new MutationObserver(syncTheme);
  headObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => {
    window.cancelAnimationFrame(frameId);
    observer.disconnect();
    headObserver.disconnect();
  };
}

function openLinkInPreview({ tabId, url, background }: DesktopPreviewOpenLinkEvent): void {
  const source = hostedBrowserSessions(
    readActivePreviewSessions(),
    appAtomRegistry.get(primaryEnvironmentIdAtom),
    remoteDeviceAccessFor(),
  ).find((session) => session.runtimeTabId === tabId);
  if (!source) return;
  void openUrlInPreview({
    threadRef: source.threadRef,
    url,
    openPreview: (input) => runAtomCommand(appAtomRegistry, previewEnvironment.open, input),
    profileId: source.snapshot.profileId,
    background,
  });
}

function startRemoteTabMirror(): () => void {
  const bridge = window.desktopBridge?.desktopBrowser;
  if (!bridge) return () => {};
  const created = new Set<string>();
  const sent = new Map<string, string>();
  const sync = () => {
    const live = new Set<string>();
    for (const session of hostedBrowserSessions(
      readActivePreviewSessions(),
      appAtomRegistry.get(primaryEnvironmentIdAtom),
      remoteDeviceAccessFor(),
    )) {
      const { mirrorUrl } = remoteTabUrls(session);
      const tabId = session.runtimeTabId;
      if (mirrorUrl === null) continue;
      live.add(tabId);
      if (!created.has(tabId) || sent.get(tabId) === mirrorUrl) continue;
      sent.set(tabId, mirrorUrl);
      const command = JSON.stringify({ type: "mirror", tabId, url: mirrorUrl });
      withDesktopTab(tabId, () => bridge.sendCommand(command));
    }
    for (const tabId of sent.keys()) if (!live.has(tabId)) sent.delete(tabId);
  };
  const disposers = [
    onDesktopTabCreated((tabId) => {
      created.add(tabId);
      sent.delete(tabId);
      sync();
    }),
    subscribeActivePreviewSessions(sync),
    appAtomRegistry.subscribe(primaryEnvironmentIdAtom, sync),
    subscribeClientSettings(sync),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** App-lifetime listeners for the desktop preview bridge: annotation theme, agent pointer, links. */
export function startElectronBrowserHost(): () => void {
  const preview = window.desktopBridge?.preview;
  if (!preview) return () => {};
  const disposers = [
    startAnnotationThemeSync(preview),
    preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    }),
    preview.onOpenLink(openLinkInPreview),
    startRemoteBrowserRelays(window.desktopBridge?.getDeviceName?.() ?? "unknown"),
    startRemoteTabMirror(),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export function ElectronBrowserHost() {
  const previewByThreadKey = useActivePreviewSessions();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  useDesktopHostedPreviewSessions(primaryEnvironmentId);
  const access = useRemoteDeviceAccess();
  useRemoteDeviceTabSessions(
    access === "off" ? null : (window.desktopBridge?.getDeviceName?.() ?? null),
  );
  const accessFor = useRemoteDeviceAccessFor();
  const sessions = hostedBrowserSessions(previewByThreadKey, primaryEnvironmentId, accessFor);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map((session) => {
        const { threadRef, snapshot, remote, driven, runtimeTabId, pictureInPicture, zoomFactor } =
          session;
        const { serverUrl, remoteUrl, mirrored } = remoteTabUrls(session);
        const initialUrl = remote ? (mirrored ? null : remoteUrl) : serverUrl;
        return (
          <AuthorizedBrowserWebview
            key={runtimeTabId}
            threadRef={threadRef}
            tabId={snapshot.tabId}
            runtimeTabId={runtimeTabId}
            initialUrl={initialUrl}
            viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
            pictureInPicture={pictureInPicture}
            profileId={remote ? REMOTE_DEVICE_BROWSER_PROFILE_ID : snapshot.profileId}
            zoomFactor={zoomFactor}
            serverDriven={driven}
            {...(driven && snapshot.device !== undefined ? { remoteDevice: snapshot.device } : {})}
            mirrored={mirrored}
            {...(snapshot.runtime === "server"
              ? {
                  serverRendering: {
                    colorScheme: snapshot.colorScheme ?? "system",
                    zoomFactor: snapshot.zoomFactor ?? 1,
                  },
                }
              : {})}
          />
        );
      })}
    </div>
  );
}

function AuthorizedBrowserWebview(props: ComponentProps<typeof HostedBrowserWebview>) {
  const canOperatePreview = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthPreviewOperateScope,
  );
  const profileId = useTabProfileId(props.profileId);
  return canOperatePreview ? <HostedBrowserWebview {...props} profileId={profileId} /> : null;
}

// Latch after hydration: Electron fixes the partition when the guest attaches.
function useTabProfileId(profileId: string | undefined): string | undefined {
  const hydrated = useClientSettingsHydrated();
  const defaultProfileId = useBrowserDefaults().profileId;
  const [fallback, setFallback] = useState<string | undefined>(undefined);
  if (profileId === undefined && hydrated && fallback === undefined) {
    setFallback(defaultProfileId);
  }
  return profileId ?? fallback;
}
