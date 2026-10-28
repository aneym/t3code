import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export interface ConnectionChipStatus {
  readonly label: string;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "background";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly waiting: boolean;
      readonly onPress: () => void;
      readonly action: FloatingStatusAction;
    }
  | {
      readonly kind: "lifecycle";
      readonly state: "snoozed" | "settled" | "woke";
      readonly label: string;
      readonly action: FloatingStatusAction;
    }
  | { readonly kind: "goal"; readonly label: string; readonly accessibilityLabel: string }
  | { readonly kind: "preparing"; readonly label: string };

export function connectionChipStatus(input: {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError?: string | null;
  readonly onReconnect: () => void;
  readonly queuedCount: number;
}): ConnectionChipStatus | null {
  if (input.connectionState === "connected") {
    return input.queuedCount > 0
      ? { label: `${input.queuedCount} queued`, onPress: input.onReconnect }
      : null;
  }
  const label =
    input.connectionState === "offline"
      ? "Offline"
      : input.connectionState === "connecting" || input.connectionState === "reconnecting"
        ? "Reconnecting"
        : input.connectionState === "error"
          ? input.connectionError
            ? `Connection failed: ${input.connectionError}`
            : "Connection failed"
          : input.connectionState === "unsupported"
            ? "Client not supported"
            : "Not connected";
  return {
    label: input.queuedCount > 0 ? `${label} · ${input.queuedCount} queued` : label,
    onPress: input.onReconnect,
  };
}
