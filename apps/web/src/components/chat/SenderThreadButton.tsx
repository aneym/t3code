import { useEnvironment } from "../../state/environments";
import type { EnvironmentId, MessageSender, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { InlineButton } from "../ui/button";

export function SenderThreadButton(props: {
  readonly environmentId: EnvironmentId;
  readonly sender: MessageSender;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const threadId = props.sender.senderThreadId;
  const environmentId = props.sender.senderEnvironmentId ?? props.environmentId;
  const environment = useEnvironment(environmentId);
  if (threadId === undefined || (environmentId !== props.environmentId && environment === null))
    return null;
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
