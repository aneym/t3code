import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useEffect } from "react";

import { type EmbedSendRun, followEmbedSends } from "./embedSendMarks";

export function useEmbedSendMarks(
  thread: string | null,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  latestRun: EmbedSendRun | null,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports send milestones the server projection shows to the embed host
  useEffect(() => {
    if (thread !== null) followEmbedSends(thread, items, latestRun);
  }, [thread, items, latestRun]);
}
