import { stripInlineContextReferences } from "../lib/composerContextReferences";
import { randomUUID } from "../lib/utils";
import { postToEmbedHost } from "./embedHost";
import { EMBED_SEND_MESSAGE, type EmbedSendOutcome, type EmbedSendWhen } from "./embedProtocol";

let hostSends = false;
const waiting = new Map<
  string,
  { readonly commandId: string; readonly answer: (outcome: EmbedSendOutcome) => void }
>();

export function setEmbedHostSend(on: boolean): void {
  hostSends = on;
}

export function isEmbedHostSendOn(): boolean {
  return hostSends;
}

export function applyEmbedSendResult(result: EmbedSendOutcome): void {
  const commandId = waiting.get(result.requestId)?.commandId;
  if (commandId === undefined) return;
  for (const [requestId, attempt] of waiting) {
    if (attempt.commandId !== commandId) continue;
    waiting.delete(requestId);
    attempt.answer(result);
  }
}

const EMBED_SEND_TIMEOUT_MS = 10_000;

export type EmbedSendSettled =
  | EmbedSendOutcome
  | { readonly requestId: string; readonly outcome: "unanswered" };

export function sendThroughEmbedHost(
  input: {
    readonly thread: string;
    readonly requestId: string;
    readonly commandId: string;
    readonly messageId: string;
    readonly text: string;
    readonly when: EmbedSendWhen;
  },
  onLate: (result: EmbedSendOutcome) => void,
): Promise<EmbedSendSettled> | null {
  if (!hostSends) return null;
  let settle: (result: EmbedSendSettled) => void = () => undefined;
  const outcome = new Promise<EmbedSendSettled>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => {
    if (!waiting.has(input.requestId)) return;
    waiting.set(input.requestId, { commandId: input.commandId, answer: onLate });
    settle({ requestId: input.requestId, outcome: "unanswered" });
  }, EMBED_SEND_TIMEOUT_MS);
  waiting.set(input.requestId, {
    commandId: input.commandId,
    answer: (result) => {
      clearTimeout(timer);
      settle(result);
    },
  });
  if (postToEmbedHost({ type: EMBED_SEND_MESSAGE, ...input })) return outcome;
  clearTimeout(timer);
  waiting.delete(input.requestId);
  return null;
}

type SendShapeInput = {
  readonly messageText: string;
  readonly attachments: ReadonlyArray<unknown>;
  readonly files: ReadonlyArray<unknown>;
  readonly terminalContexts: ReadonlyArray<unknown>;
  readonly previewAnnotations: ReadonlyArray<unknown>;
  readonly reviewComments: ReadonlyArray<unknown>;
  readonly threadContexts: ReadonlyArray<unknown>;
  readonly environmentContexts: ReadonlyArray<unknown>;
};

export function embedSendShape(input: SendShapeInput): "text" | "files" | null {
  if (stripInlineContextReferences(input.messageText).trim() === "") return null;
  const contexts = [
    input.terminalContexts,
    input.previewAnnotations,
    input.reviewComments,
    input.threadContexts,
    input.environmentContexts,
  ];
  if (contexts.some((list) => list.length > 0)) return null;
  return input.attachments.length + input.files.length === 0 ? "text" : "files";
}

export function postDirectToEmbedHost(input: {
  readonly thread: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly steer: boolean;
}): boolean {
  if (!hostSends) return false;
  return postToEmbedHost({
    type: EMBED_SEND_MESSAGE,
    direct: true,
    thread: input.thread,
    requestId: randomUUID(),
    commandId: input.commandId,
    messageId: input.messageId,
    text: stripInlineContextReferences(input.text).trim(),
    when: input.steer ? "steer" : "queue",
  });
}
