import { type ComponentProps, lazy, Suspense } from "react";

import type { ChatTerminalDrawers as ChatTerminalDrawersView } from "./ChatTerminalDrawers";
import type { RightPanelSurfaceContent as RightPanelSurfaceContentView } from "./RightPanelSurfaceContent";
import type { ThreadDetailsPanel as ThreadDetailsPanelView } from "./ThreadDetailsPanel";

const ChatTerminalDrawersChunk = lazy(() =>
  import("./ChatTerminalDrawers").then((module) => ({ default: module.ChatTerminalDrawers })),
);
const RightPanelSurfaceContentChunk = lazy(() =>
  import("./RightPanelSurfaceContent").then((module) => ({
    default: module.RightPanelSurfaceContent,
  })),
);
const ThreadDetailsPanelChunk = lazy(() =>
  import("./ThreadDetailsPanel").then((module) => ({ default: module.ThreadDetailsPanel })),
);

export function RightPanelSurfaceContent(
  props: ComponentProps<typeof RightPanelSurfaceContentView>,
) {
  return (
    <Suspense fallback={null}>
      <RightPanelSurfaceContentChunk {...props} />
    </Suspense>
  );
}

export function ThreadDetailsPanel(props: ComponentProps<typeof ThreadDetailsPanelView>) {
  return (
    <Suspense fallback={null}>
      <ThreadDetailsPanelChunk {...props} />
    </Suspense>
  );
}

export function ChatTerminalDrawers(props: ComponentProps<typeof ChatTerminalDrawersView>) {
  return (
    <Suspense fallback={null}>
      <ChatTerminalDrawersChunk {...props} />
    </Suspense>
  );
}
