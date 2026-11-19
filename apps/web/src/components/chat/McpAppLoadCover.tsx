import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

type McpAppLoadState = "loading" | "ready" | "failed";

const MCP_APP_LOAD_TIMEOUT_MS = 6_000;

const READY_METHODS = new Set([
  "ui/initialize",
  "ui/notifications/initialized",
  "ui/notifications/size-changed",
]);

function isMcpAppReadyMessage(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const method = (data as { readonly method?: unknown }).method;
  return typeof method === "string" && READY_METHODS.has(method);
}

export function useMcpAppLoad() {
  const [state, setState] = useState<McpAppLoadState>("loading");
  return {
    state,
    reset: () => setState("loading"),
    observe: (data: unknown) => {
      if (isMcpAppReadyMessage(data)) setState("ready");
    },
    arm: () => {
      const timer = setTimeout(
        () => setState((current) => (current === "loading" ? "failed" : current)),
        MCP_APP_LOAD_TIMEOUT_MS,
      );
      return () => clearTimeout(timer);
    },
  };
}

export function McpAppLoadCover(props: {
  readonly server: string;
  readonly state: "loading" | "failed";
  readonly onRetry: () => void;
}) {
  if (props.state === "failed") {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-background text-muted-foreground text-xs">
        <span>Couldn't load this card</span>
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-label={`Loading the ${props.server} app`}
      className="pointer-events-none absolute inset-0 flex flex-col gap-3 rounded-lg border border-border bg-background p-4"
    >
      <Skeleton motion="still" className="h-4 w-1/3" />
      <Skeleton motion="still" className="h-3 w-2/3" />
      <Skeleton motion="still" shape="card" className="min-h-0 flex-1" />
    </div>
  );
}
