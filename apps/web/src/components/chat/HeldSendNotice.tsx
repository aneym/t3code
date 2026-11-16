import { Clock3Icon, RefreshCwIcon } from "lucide-react";
import { useEffect } from "react";

import { useConnectionOutage } from "../../hooks/useConnectionOutage";
import type { EnvironmentPresentation } from "../../state/environments";
import { InlineButton } from "../ui/button";
import { failHeldSend, HELD_SEND_LIMIT_MS, type HeldSend } from "./heldSendStore";

const noticeClassName =
  "mx-auto flex w-full max-w-(--chat-content-max-width) justify-end pe-1 pb-4 text-muted-foreground text-xs";

export function HeldSendNotice({
  threadKey,
  held,
  environment,
  onRetry,
}: {
  readonly threadKey: string;
  readonly held: HeldSend | null;
  readonly environment: EnvironmentPresentation | null;
  readonly onRetry: () => void;
}) {
  const label = environment?.label ?? "the server";
  const outage = useConnectionOutage(
    environment?.environmentId ?? null,
    environment?.connection.phase ?? "available",
  );
  const waitingSince = held?.status === "waiting" ? held.since : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer turns a held send into "Not sent" once it has waited past the limit
  useEffect(() => {
    if (waitingSince === null) return;
    const timer = setTimeout(
      () => failHeldSend(threadKey),
      Math.max(0, waitingSince + HELD_SEND_LIMIT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [waitingSince, threadKey]);

  if (held === null) {
    if (!outage.reconnecting) return null;
    return (
      <div className={noticeClassName} data-reconnecting role="status">
        <span className="flex items-center gap-1.5">
          <RefreshCwIcon aria-hidden className="size-3.5 shrink-0" />
          {`Reconnecting to ${label}…`}
        </span>
      </div>
    );
  }
  return (
    <div className={noticeClassName} data-held-send={held.status} role="status">
      {held.status === "waiting" ? (
        <span className="flex items-center gap-1.5">
          <Clock3Icon aria-hidden className="size-3.5 shrink-0" />
          {`Not sent yet · sends when ${label} reconnects`}
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="text-foreground">Not sent</span>
          <span aria-hidden>·</span>
          <InlineButton onClick={onRetry}>Retry</InlineButton>
        </span>
      )}
    </div>
  );
}
