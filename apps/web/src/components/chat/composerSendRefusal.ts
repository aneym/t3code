import { refuseEmbedSend } from "../../embed/embedSendMarks";
import { stackedThreadToast, toastManager } from "../ui/toast";

export interface ComposerSendGate {
  readonly canOperate: boolean;
  readonly threadReady: boolean;
  readonly reverting: boolean;
  readonly settingsHydrated: boolean;
  readonly messagesLoading: boolean;
  readonly environmentChanging: boolean;
  readonly feedbackUploading: boolean;
}

export type ComposerSendRefusal = readonly [
  condition: string,
  title: string,
  description: string,
  type?: "warning" | "info",
];

const TRY_AGAIN = "Your message is still in the box. Try again in a moment.";

export const THREAD_NOT_LOADED: ComposerSendRefusal = [
  "thread-not-loaded",
  "Not sent: chat still loading",
  TRY_AGAIN,
];

export const NO_OPERATE_SCOPE_REFUSAL: ComposerSendRefusal = [
  "no-operate-scope",
  "Not sent: still connecting",
  `This chat has not finished signing in, or it can only read. ${TRY_AGAIN}`,
];

const MESSAGES_LOADING_REFUSAL: ComposerSendRefusal = [
  "thread-detail-loading",
  "Not sent: messages still loading",
  TRY_AGAIN,
];

export function composerSendGateRefusal(gate: ComposerSendGate): ComposerSendRefusal | null {
  if (!gate.canOperate) return NO_OPERATE_SCOPE_REFUSAL;
  if (!gate.threadReady) return THREAD_NOT_LOADED;
  if (!gate.settingsHydrated) {
    return ["settings-not-hydrated", "Not sent: settings still loading", TRY_AGAIN];
  }
  if (gate.messagesLoading) return MESSAGES_LOADING_REFUSAL;
  if (gate.environmentChanging) {
    return ["environment-changing", "Not sent: preparing the machine", TRY_AGAIN];
  }
  if (gate.reverting) {
    return [
      "reverting-checkpoint",
      "Not sent: rewinding the conversation",
      "Send again when the rewind finishes.",
    ];
  }
  if (gate.feedbackUploading) {
    return [
      "feedback-uploading",
      "Not sent: feedback still uploading",
      "Send again when the feedback finishes.",
    ];
  }
  return null;
}

export function holdComposerAnnotation(condition: string): void {
  console.warn(`[composer-send] annotation held: ${condition}`);
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: "Annotation attached to draft",
      description: "Sending is unavailable right now. Finish the current action, then send.",
    }),
  );
}

export function refuseComposerSend(refusal: ComposerSendRefusal, annotation = false): void {
  const [condition, title, description, type = "warning"] = refusal;
  if (annotation) return holdComposerAnnotation(condition);
  console.warn(`[composer-send] not sent: ${condition}`);
  refuseEmbedSend();
  toastManager.add(stackedThreadToast({ type, title, description }));
}
