import { useAtomMount, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { startEmbedAudience } from "../../embed/embedAudience";
import { startEmbedControls } from "../../embed/embedComposer";
import { placeEmbedHost, type EmbedHostSpot } from "../../embed/embedHost";
import { isEmbedPath, normalizeEmbedOrigins, readEmbedScheme } from "../../embed/embedProtocol";
import { applyEmbedTheme, themeFromEmbedMessage } from "../../embed/embedTheme";
import { useEmbedConnectionReport } from "../../embed/useEmbedConnectionReport";
import { useEmbedHostBridge } from "../../embed/useEmbedHostBridge";
import { useEmbedNavigationPrefetch } from "../../embed/useEmbedNavigationPrefetch";
import { useEmbedDocumentTitle } from "../../embed/useEmbedDocumentTitle";
import {
  useEmbedKeptView,
  useEmbedKeptViewUpkeep,
  useEmbedSavedHidden,
} from "../../embed/useEmbedKeptView";
import { useEmbedReadyReport } from "../../embed/useEmbedReadyReport";
import { useEmbedRouting } from "../../embed/useEmbedRouting";
import { releaseEmbedThreadPrefetch } from "../../embed/embedThreadPrefetch";
import { primaryServerConfigAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreads } from "../../state/threads";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { EmbedConnectionNotice } from "./EmbedConnectionNotice";
import "./EmbedPage.css";
import { ThreadRouteView } from "../ThreadRouteView";
import { SidebarProvider } from "../ui/sidebar";

const BARE_LAYOUT_STYLE = { "--sidebar-width": "0px" } as CSSProperties;

function applyInitialScheme(): void {
  const scheme = readEmbedScheme(new URLSearchParams(window.location.search).get("scheme"));
  if (scheme !== null) applyEmbedTheme(themeFromEmbedMessage({ scheme, vars: {} }));
}

function EmbedNotice({ text }: { readonly text: string }) {
  return (
    <main className="flex h-dvh w-full items-center justify-center bg-background p-6">
      <p className="max-w-sm text-center text-sm text-muted-foreground">{text}</p>
    </main>
  );
}

function EmbedPrefetch({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useAtomMount(environmentShell.stateAtom(threadRef.environmentId));
  useAtomMount(environmentThreads.stateAtom(threadRef.environmentId, threadRef.threadId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the boot-time thread subscription to this mount once it holds the same atom
  useEffect(releaseEmbedThreadPrefetch, []);
  useEmbedNavigationPrefetch();
  return null;
}

function EmbedConnectionReport({ environmentId }: { readonly environmentId: EnvironmentId }) {
  useEmbedConnectionReport(environmentId);
  return null;
}

function EmbedFrame({
  spot,
  environmentId,
  threadId,
  children,
}: {
  readonly spot: EmbedHostSpot;
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly children: ReactNode;
}) {
  useEmbedHostBridge(spot.origin, spot.framed, threadId);
  useEmbedRouting(spot.origin, spot.framed, environmentId, threadId);
  useBlocker({
    shouldBlockFn: ({ next }) => !isEmbedPath(next.pathname),
    enableBeforeUnload: false,
  });
  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen={false} style={BARE_LAYOUT_STYLE}>
      <EmbedConnectionReport environmentId={environmentId as EnvironmentId} />
      {children}
      <ConfirmDialogHost />
    </SidebarProvider>
  );
}

export function EmbeddedThread({
  environmentId,
  threadId,
}: {
  readonly environmentId: string;
  readonly threadId: string;
}) {
  const target = resolveThreadRouteTarget({ environmentId, threadId });
  const threadRef = target?.kind === "server" ? target.threadRef : null;
  const view = useEmbedKeptView(threadRef);
  const hidden = useEmbedSavedHidden(threadRef?.environmentId ?? null);
  const unavailable = useEmbedReadyReport(threadRef, threadId, view === "hold");
  if (hidden) return null;
  if (unavailable) return <EmbedNotice text="This chat isn't available here." />;
  if (target === null || view === "hold") return null;
  return (
    <div className="contents" data-embed-view={view}>
      <ThreadRouteView target={target} />
    </div>
  );
}

export function EmbedPage({
  authenticated,
  environmentId,
  threadId,
  children,
}: {
  readonly authenticated: boolean;
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly children: ReactNode;
}) {
  useState(applyInitialScheme);
  useState(startEmbedControls);
  useState(startEmbedAudience);
  const settings = useAtomValue(primaryServerConfigAtom)?.settings ?? null;
  const target = threadId === null ? null : resolveThreadRouteTarget({ environmentId, threadId });
  useEmbedDocumentTitle(authenticated && target?.kind === "server" ? target.threadRef : null);
  const threadRef = target?.kind === "server" ? target.threadRef : null;
  const signedIn = useEmbedKeptViewUpkeep(authenticated, threadRef);
  const hidden = useEmbedSavedHidden(threadRef?.environmentId ?? null);
  if (!signedIn) return <EmbedNotice text="Sign in to continue." />;
  return (
    <>
      {threadRef !== null && !hidden ? <EmbedPrefetch threadRef={threadRef} /> : null}
      {target?.kind === "server" ? (
        <EmbedConnectionNotice environmentId={target.threadRef.environmentId} />
      ) : null}
      <EmbedContent settings={settings} environmentId={environmentId} threadId={threadId}>
        {children}
      </EmbedContent>
    </>
  );
}

function EmbedContent({
  settings,
  environmentId,
  threadId,
  children,
}: {
  readonly settings: ServerConfig["settings"] | null;
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly children: ReactNode;
}) {
  if (settings === null) return null;
  if (!settings.embedModeEnabled) {
    return <EmbedNotice text="Embedded chats are turned off on this server." />;
  }
  const placement = placeEmbedHost(normalizeEmbedOrigins(settings.embedAllowedOrigins));
  if (placement.kind === "refused") {
    return (
      <EmbedNotice text={`This chat can't be shown inside ${placement.origin ?? "this page"}.`} />
    );
  }
  return (
    <EmbedFrame spot={placement.spot} environmentId={environmentId} threadId={threadId}>
      {children}
    </EmbedFrame>
  );
}
