import type { WorkLogEntry } from "../session-logic";
import { useEmbedHostConnected } from "./embedHost";

export function useEmbedLiveActivityLabel(
  itemType: WorkLogEntry["itemType"],
  active: boolean,
): string | null {
  const embedded = useEmbedHostConnected();
  if (!embedded) return null;
  if (itemType === "reasoning") return active ? "Thinking" : "Thought";
  return active ? "Working" : "Worked";
}
