import { useState } from "react";
import { CommandId, ScheduledTaskId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { randomUUID } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function AutomationPlacementControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly marked: boolean;
  readonly bound: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const dispatch = useOrchestrationCommand(orchestrationEnvironment.v2.dispatchCommand);
  const change = async () => {
    setBusy(true);
    const result = await dispatch({
      environmentId: props.environmentId,
      input: {
        type: "thread.metadata.update",
        commandId: CommandId.make(randomUUID()),
        threadId: props.threadId,
        automationTaskId: props.marked
          ? null
          : ScheduledTaskId.make(`automation:thread:${props.threadId}`),
      },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not change automation placement",
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };
  return (
    <div className="px-2.5 py-1.5">
      <Button
        size="sm"
        variant="ghost"
        disabled={props.bound || busy}
        onClick={() => void change()}
      >
        {props.marked ? "Move to main sidebar" : "Keep under Automations"}
      </Button>
      {props.bound ? (
        <p className="text-xs text-muted-foreground">
          Remove bound tasks before moving this thread to the main sidebar.
        </p>
      ) : null}
    </div>
  );
}
