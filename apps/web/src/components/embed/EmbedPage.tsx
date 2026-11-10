import { useAtomMount, useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import { useBlocker } from "@tanstack/react-router";
import { useState, type CSSProperties, type ReactNode } from "react";

import { startEmbedControls } from "../../embed/embedComposer";
import { placeEmbedHost, type EmbedHostSpot } from "../../embed/embedHost";
import { isEmbedPath, normalizeEmbedOrigins, readEmbedScheme } from "../../embed/embedProtocol";
import { readEmbedSignIn } from "../../embed/embedSignIn";
import { applyEmbedTheme, themeFromEmbedMessage } from "../../embed/embedTheme";
import { useEmbedHostBridge } from "../../embed/useEmbedHostBridge";
import { useEmbedNavigationPrefetch } from "../../embed/useEmbedNavigationPrefetch";
import { useEmbedDocumentTitle } from "../../embed/useEmbedDocumentTitle";
import { useEmbedReadyReport } from "../../embed/useEmbedReadyReport";
import { primaryServerConfigAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreads } from "../../state/threads";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
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
    <main className="flex h-dvh items-center justify-center bg-background p-6">
      <p className="max-w-sm text-center text-sm text-muted-foreground">{text}</p>
    </main>
  );
}

function EmbedPrefetch({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useAtomMount(environmentShell.stateAtom(threadRef.environmentId));
  useAtomMount(environmentThreads.stateAtom(threadRef.environmentId, threadRef.threadId));
  useEmbedNavigationPrefetch();
  return null;
}

function EmbedFrame({
  spot,
  threadId,
  children,
}: {
  readonly spot: EmbedHostSpot;
  readonly threadId: string | null;
  readonly children: ReactNode;
}) {
  useEmbedHostBridge(spot.origin, spot.framed, threadId);
  useBlocker({
    shouldBlockFn: ({ next }) => !isEmbedPath(next.pathname),
    enableBeforeUnload: false,
  });
  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen={false} style={BARE_LAYOUT_STYLE}>
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
  useEmbedReadyReport(target?.kind === "server" ? target.threadRef : null, threadId);
  return target ? <ThreadRouteView target={target} /> : null;
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
  const settings = useAtomValue(primaryServerConfigAtom)?.settings ?? null;
  const target = threadId === null ? null : resolveThreadRouteTarget({ environmentId, threadId });
  useEmbedDocumentTitle(authenticated && target?.kind === "server" ? target.threadRef : null);
  if (!authenticated) {
    return (
      <EmbedNotice
        text={readEmbedSignIn() === "expired" ? "Sign-in expired" : "Sign in to continue."}
      />
    );
  }
  return (
    <>
      {target?.kind === "server" ? <EmbedPrefetch threadRef={target.threadRef} /> : null}
      <EmbedContent settings={settings} threadId={threadId}>
        {children}
      </EmbedContent>
    </>
  );
}

function EmbedContent({
  settings,
  threadId,
  children,
}: {
  readonly settings: ServerConfig["settings"] | null;
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
    <EmbedFrame spot={placement.spot} threadId={threadId}>
      {children}
    </EmbedFrame>
  );
}
