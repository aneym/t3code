import type { RefObject } from "react";

import type { ComposerHandleRef } from "../../composerHandleContext";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { QueuedRunsControlHandle } from "./QueuedRunsControl";
import type { ChatShortcutCommands } from "./useChatShortcuts";

export function queuedRunShortcutContext(
  target: EventTarget | null,
  prompt: string,
  hasNonPromptContent: boolean,
) {
  return {
    composerEmpty: prompt.trim() === "" && !hasNonPromptContent,
    queueFocus: target instanceof Element && target.closest("[data-thread-queue]") !== null,
  };
}

export function useQueuedRunShortcuts(
  queueRef: RefObject<QueuedRunsControlHandle | null>,
  composerRef: ComposerHandleRef,
  composerEmpty: () => boolean | null,
): ChatShortcutCommands {
  const readComposerEmpty = useStableCallback(composerEmpty);
  const queue = () => (readComposerEmpty() === null ? null : queueRef.current);
  return {
    "composer.sendAlternate": ({ event }) =>
      readComposerEmpty() === true && queue()?.steerNext(event.repeat) === true,
    "thread.steerQueuedMessage": ({ event }) => queue()?.steerNext(event.repeat) === true,
    "thread.editQueuedMessage": ({ event }) =>
      composerRef.current?.isCaretAtStart() === true && queue()?.editLatest(event.repeat) === true,
    "thread.focusQueue": ({ event }) => !event.repeat && queue()?.focusFirst() === true,
    "composer.focus": () => {
      if (!composerRef.current) return false;
      composerRef.current.focusAtEnd();
    },
  };
}
