import type { ScopedThreadRef } from "@t3tools/contracts";

import { usePreviewSession } from "./usePreviewSession";

export function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}
