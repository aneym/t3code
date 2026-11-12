import { MCP_APP_CARD_HEIGHT } from "@t3tools/shared/mcpAppCard";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { APP_CARD_READY_TIMEOUT_MS, readAppCardReadyState } from "./appCardFrame.logic";

const failedOrigins = new Set<string>();

type FrameState = "pending" | "ready" | "failed";

export function AppCardFrame({ src, title }: { readonly src: string; readonly title: string }) {
  const origin = new URL(src).origin;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<FrameState>(() =>
    failedOrigins.has(origin) ? "failed" : "pending",
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for the card page's ready ping, posted from a window outside React
  useEffect(() => {
    if (state !== "pending") return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== origin) return;
      const ready = readAppCardReadyState(event.data);
      if (ready !== null) setState(ready === "app" ? "ready" : "failed");
    };
    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(() => {
      failedOrigins.add(origin);
      setState("failed");
    }, APP_CARD_READY_TIMEOUT_MS);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, [origin, state]);
  if (state === "failed") return null;
  return (
    <div className="min-w-0 px-1 pb-2">
      <div
        className="w-full overflow-hidden rounded-lg bg-muted/40"
        style={{ height: MCP_APP_CARD_HEIGHT }}
        data-app-card-state={state}
      >
        <iframe
          ref={frameRef}
          src={src}
          title={title}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          allow="clipboard-write"
          referrerPolicy="no-referrer"
          className={cn("block size-full border-0", state === "pending" && "invisible")}
        />
      </div>
    </div>
  );
}
