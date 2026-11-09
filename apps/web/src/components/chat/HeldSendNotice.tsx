import { Clock3Icon } from "lucide-react";
import { useEffect } from "react";

import { InlineButton } from "../ui/button";
import { failHeldSend, HELD_SEND_LIMIT_MS, type HeldSend } from "./heldSendStore";

export function HeldSendNotice({
  threadKey,
  held,
  label,
  onRetry,
}: {
  readonly threadKey: string;
  readonly held: HeldSend;
  readonly label: string;
  readonly onRetry: () => void;
}) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer turns a held send into "Not sent" once it has waited past the limit
  useEffect(() => {
    if (held.status !== "waiting") return;
    const timer = setTimeout(
      () => failHeldSend(threadKey),
      Math.max(0, held.since + HELD_SEND_LIMIT_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [held.since, held.status, threadKey]);

  return (
    <div
      className="mx-auto flex w-full max-w-(--chat-content-max-width) justify-end pe-1 pb-4 text-muted-foreground text-xs"
      data-held-send={held.status}
      role="status"
    >
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
