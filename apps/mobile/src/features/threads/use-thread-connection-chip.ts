import { useFocusEffect } from "@react-navigation/native";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { useCallback } from "react";

import { useDelayedStatus } from "../../lib/useDelayedStatus";
import { setOpenThreadCacheKey } from "../../state/thread-cache-protection";
import { connectionChipStatus } from "./floating-working-status";

export function useThreadConnectionChip(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly onReconnect: () => void;
  readonly queuedCount: number;
}) {
  const key = `${input.environmentId}:${input.threadId}`;
  useFocusEffect(
    useCallback(() => {
      setOpenThreadCacheKey(key);
      return () => setOpenThreadCacheKey(null);
    }, [key]),
  );
  const status = connectionChipStatus(input);
  const label = useDelayedStatus(key, status?.label ?? null, {
    showDelayMs:
      input.connectionState === "offline" ||
      input.connectionState === "connecting" ||
      input.connectionState === "reconnecting"
        ? 4_000
        : 0,
  });
  return label === null ? null : { label, onPress: input.onReconnect };
}
