import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  shouldShowLoadEarlierControl,
  type ThreadHistoryMeta,
} from "@t3tools/client-runtime/state/threads";

import { useChatSession } from "../../chatSessionMode";
import { useServerConfigs, useThreadStatus } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";

export function useThreadHistoryControls(
  ref: ScopedThreadRef | null,
  history: ThreadHistoryMeta,
): MessagesTimelineHistoryControls | undefined {
  const chatSession = useChatSession();
  const status = useThreadStatus(ref);
  const serverConfigs = useServerConfigs();
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  if (ref === null || !shouldShowLoadEarlierControl(history)) return undefined;
  const socketHistory =
    serverConfigs.get(ref.environmentId)?.environment.capabilities.threadHistoryRpc === true;
  if (chatSession && (!socketHistory || status !== "live")) return undefined;
  return {
    hasMoreHistory: history.hasMoreHistory,
    loading: history.loading,
    error: history.error,
    onLoadEarlier: (throughEntryId) => {
      void loadEarlier({
        environmentId: ref.environmentId,
        input: {
          threadId: ref.threadId,
          ...(throughEntryId === undefined ? {} : { throughEntryId }),
        },
      });
    },
  };
}
