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
