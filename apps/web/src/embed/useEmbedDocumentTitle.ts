import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { useThreadShell } from "../state/entities";

export function useEmbedDocumentTitle(threadRef: ScopedThreadRef | null): void {
  const title = useThreadShell(threadRef)?.title.trim() || "Chat";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the browser tab title lives outside React
  useEffect(() => {
    document.title = title;
  }, [title]);
}
