import { useAtomValue } from "@effect/atom-react";
import {
  planSendAllQueued,
  sendAllQueued,
  type ThreadQueueWorkflowState,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useRef } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useEmbedHostConnected } from "../../embed/embedHost";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SendAllQueuedButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workflow: ThreadQueueWorkflowState;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly onBusyChange: (runId: RunId | null) => void;
}) {
  const enabled =
    useAtomValue(serverEnvironment.configValueAtom(props.environmentId))?.settings.queueSendAll ===
    true;
  const embedded = useEmbedHostConnected();
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const activeRunId = useStableCallback(() => props.workflow.activeRun?.id ?? null);
  const inFlight = useRef(false);
  const plan = planSendAllQueued(props.workflow, props.editing);
  if ((!enabled && !embedded) || plan === null) return null;

  const send = async () => {
    if (inFlight.current || props.busy) return;
    inFlight.current = true;
    props.onBusyChange(props.workflow.queuedRuns[0]?.run.id ?? null);
    const input = { threadId: props.threadId };
    await sendAllQueued(plan, {
      start: async () =>
        (await resume({ environmentId: props.environmentId, input }))._tag === "Success",
      steer: async (queuedRunId, targetRunId) =>
        (
          await promote({
            environmentId: props.environmentId,
            input: { ...input, queuedRunId, targetRunId },
          })
        )._tag === "Success",
      activeRunId,
    }).finally(() => {
      inFlight.current = false;
      props.onBusyChange(null);
    });
  };

  return (
    <div className="flex justify-end">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              data-queue-action
              data-queue-send-all="true"
              variant="outline"
              size="xs"
              disabled={props.busy}
              onClick={() => void send()}
            >
              <SendIcon />
              Send all
            </Button>
          }
        />
        <TooltipPopup>{plan.description}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
