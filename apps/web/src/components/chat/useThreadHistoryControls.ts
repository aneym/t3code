import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  shouldShowLoadEarlierControl,
  type ThreadHistoryMeta,
} from "@t3tools/client-runtime/state/threads";

import { useChatSession } from "../../chatSessionMode";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";

export function useThreadHistoryControls(
  ref: ScopedThreadRef | null,
  history: ThreadHistoryMeta,
): MessagesTimelineHistoryControls | undefined {
  const chatSession = useChatSession();
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  if (ref === null || chatSession || !shouldShowLoadEarlierControl(history)) return undefined;
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
