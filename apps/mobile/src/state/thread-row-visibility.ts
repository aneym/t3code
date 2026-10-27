import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "./preferences";

export function useThreadRowVisibility() {
  const machine = useAtomValue(mobilePreferencesAtom, (result) =>
    AsyncResult.isSuccess(result)
      ? (result.value.sidebarThreadShowMachine ?? DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowMachine)
      : DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowMachine,
  );
  const agent = useAtomValue(mobilePreferencesAtom, (result) =>
    AsyncResult.isSuccess(result)
      ? (result.value.sidebarThreadShowAgent ?? DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowAgent)
      : DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowAgent,
  );
  const statusText = useAtomValue(mobilePreferencesAtom, (result) =>
    AsyncResult.isSuccess(result)
      ? (result.value.sidebarThreadShowStatusText ??
        DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowStatusText)
      : DEFAULT_UNIFIED_SETTINGS.sidebarThreadShowStatusText,
  );
  return useMemo(() => ({ machine, agent, statusText }), [machine, agent, statusText]);
}
