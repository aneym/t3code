import type { EnvironmentId, MessageSender, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { InlineButton } from "../ui/button";

export function SenderThreadButton(props: {
  readonly environmentId: EnvironmentId;
  readonly sender: MessageSender;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const threadId = props.sender.senderThreadId;
  if (threadId === undefined) return null;
  const environmentId = props.sender.senderEnvironmentId ?? props.environmentId;
  return environmentId === props.environmentId ? (
    <InlineButton onClick={() => props.onOpenThread(threadId)} tone="muted">
      Open thread
    </InlineButton>
  ) : (
    <InlineButton
      tone="muted"
      render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
    >
      Open thread
    </InlineButton>
  );
}
