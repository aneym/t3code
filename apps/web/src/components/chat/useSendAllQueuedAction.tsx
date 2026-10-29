import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveThreadQueueWorkflowState,
  describeSendAllQueued,
} from "@t3tools/client-runtime/state/thread-workflows";
import { SendIcon } from "lucide-react";
import { useThreadProjection, useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ITEM_ICON_CLASS,
  type CommandPaletteSubmenuItem,
  type CommandPaletteActionItem,
} from "../CommandPalette.logic";

export function useQueueActions(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const projection = useThreadProjection(
    thread === null ? null : scopeThreadRef(thread.environmentId, thread.id),
  )?.projection;
  const config = useServerConfigs().get(thread?.environmentId ?? ("" as EnvironmentId));
  const sendAll = useAtomCommand(threadEnvironment.sendAllQueuedRuns);
  if (thread === null || !config?.settings.queueSendAll || !projection) return [];
  const workflow = deriveThreadQueueWorkflowState(projection);
  if (!workflow.canSendAll) return [];
  return [
    {
      kind: "action",
      value: "thread.sendAllQueued",
      title: "Send all queued messages",
      description: describeSendAllQueued(workflow),
      searchTerms: ["send all queued messages bulk queue steer"],
      icon: <SendIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.sendAllQueued",
      run: async () => {
        await sendAll({ environmentId: thread.environmentId, input: { threadId: thread.id } });
      },
    },
  ];
}
