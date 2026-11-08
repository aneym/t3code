import { useAtomValue } from "@effect/atom-react";
import { useBlocker } from "@tanstack/react-router";
import { useState, type CSSProperties } from "react";

import { placeEmbedHost, type EmbedHostSpot } from "../../embed/embedHost";
import { isEmbedPath, normalizeEmbedOrigins, readEmbedScheme } from "../../embed/embedProtocol";
import { readEmbedSignIn } from "../../embed/embedSignIn";
import { applyEmbedTheme, themeFromEmbedMessage } from "../../embed/embedTheme";
import { useEmbedHostBridge } from "../../embed/useEmbedHostBridge";
import { primaryServerConfigAtom } from "../../state/server";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
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

function EmbeddedThread({
  spot,
  environmentId,
  threadId,
}: {
  readonly spot: EmbedHostSpot;
  readonly environmentId: string;
  readonly threadId: string;
}) {
  useEmbedHostBridge(spot.origin, spot.framed, threadId);
  useBlocker({
    shouldBlockFn: ({ next }) => !isEmbedPath(next.pathname),
    enableBeforeUnload: false,
  });
  const target = resolveThreadRouteTarget({ environmentId, threadId });
  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen={false} style={BARE_LAYOUT_STYLE}>
      {target ? <ThreadRouteView target={target} /> : null}
      <ConfirmDialogHost />
    </SidebarProvider>
  );
}

export function EmbedPage({
  authenticated,
  environmentId,
  threadId,
}: {
  readonly authenticated: boolean;
  readonly environmentId: string;
  readonly threadId: string;
}) {
  useState(applyInitialScheme);
  const settings = useAtomValue(primaryServerConfigAtom)?.settings ?? null;
  if (!authenticated) {
    return (
      <EmbedNotice
        text={readEmbedSignIn() === "expired" ? "Sign-in expired" : "This chat needs a T3 sign-in."}
      />
    );
  }
  if (settings === null) return null;
  if (!settings.embedModeEnabled) {
    return <EmbedNotice text="Embedded chats are off on this T3 server." />;
  }
  const placement = placeEmbedHost(normalizeEmbedOrigins(settings.embedAllowedOrigins));
  if (placement.kind === "refused") {
    return (
      <EmbedNotice text={`This chat can't be shown inside ${placement.origin ?? "this page"}.`} />
    );
  }
  return <EmbeddedThread spot={placement.spot} environmentId={environmentId} threadId={threadId} />;
}
