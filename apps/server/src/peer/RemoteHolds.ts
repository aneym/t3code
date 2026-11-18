import type { AgentPlacementHold } from "@t3tools/contracts";

const holds = new Map<string, AgentPlacementHold>();

export const rememberHold = (threadId: string, hold: AgentPlacementHold | undefined) => {
  if (hold === undefined) return;
  if (holds.size >= 256) holds.clear();
  holds.set(threadId, hold);
};

export const heldThere = (threadId: string) => holds.get(threadId);
