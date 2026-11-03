import type { MessageId, OrchestrationV2ComposerSubmit } from "@t3tools/contracts";

export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** False while the active turn cannot take steering input, such as during compaction. */
  readonly canSteer?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}

const STILL_WRITING = new Set(["pending", "running", "waiting"]);

export function composerSubmitStamp(
  rows: ReadonlyArray<{
    readonly item: {
      readonly type: string;
      readonly status: string;
      readonly messageId?: MessageId;
    };
  }>,
): OrchestrationV2ComposerSubmit {
  const newest = rows.findLast((row) => row.item.type === "assistant_message")?.item;
  return {
    displayedAssistantMessageId:
      newest === undefined || STILL_WRITING.has(newest.status) ? null : (newest.messageId ?? null),
  };
}
