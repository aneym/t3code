import { useAtomValue } from "@effect/atom-react";
import {
  planSendAllQueued,
  sendAllQueued,
  type ThreadQueueWorkflowState,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useInsertionEffect, useRef } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadQueueSendAll(props: {
  readonly target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  readonly workflow: ThreadQueueWorkflowState;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const enabled =
    useAtomValue(serverEnvironment.configValueAtom(props.target.environmentId))?.settings
      .queueSendAll === true;
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun, "promote queued message");
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue, "resume queue");
  const activeRunId = useRef<RunId | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the send loop reads the newest active run between awaited steers
  useInsertionEffect(() => {
    activeRunId.current = props.workflow.activeRun?.id ?? null;
  });
  const plan = planSendAllQueued(props.workflow, props.editing);
  if (!enabled || plan === null) return null;

  const input = { threadId: props.target.threadId };
  const environmentId = props.target.environmentId;
  return (
    <View className="gap-2 py-3">
      <Text className="text-sm text-foreground-muted">{plan.description}</Text>
      <Button
        label="Send all"
        disabled={props.busy}
        onPress={async () => {
          if (props.busy) return;
          props.onBusyChange(true);
          void Haptics.selectionAsync();
          await sendAllQueued(plan, {
            start: async () => (await resume({ environmentId, input }))._tag === "Success",
            steer: async (queuedRunId, targetRunId) =>
              (
                await promote({
                  environmentId,
                  input: { ...input, queuedRunId, targetRunId },
                })
              )._tag === "Success",
            activeRunId: () => activeRunId.current,
          }).finally(() => props.onBusyChange(false));
        }}
      />
    </View>
  );
}
