import { postToEmbedHost } from "./embedHost";
import { EMBED_SEND_MESSAGE, type EmbedSendOutcome, type EmbedSendWhen } from "./embedProtocol";

let hostSends = false;
const waiting = new Map<string, (outcome: EmbedSendOutcome) => void>();

export function setEmbedHostSend(on: boolean): void {
  hostSends = on;
}

export function applyEmbedSendResult(result: EmbedSendOutcome): void {
  const settle = waiting.get(result.requestId);
  if (settle === undefined) return;
  waiting.delete(result.requestId);
  settle(result);
}

const EMBED_SEND_TIMEOUT_MS = 10_000;

export type EmbedSendSettled =
  | EmbedSendOutcome
  | { readonly requestId: string; readonly outcome: "unanswered" };

export function sendThroughEmbedHost(
  input: {
    readonly thread: string;
    readonly requestId: string;
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
    waiting.set(input.requestId, onLate);
    settle({ requestId: input.requestId, outcome: "unanswered" });
  }, EMBED_SEND_TIMEOUT_MS);
  waiting.set(input.requestId, (result) => {
    clearTimeout(timer);
    settle(result);
  });
  if (postToEmbedHost({ type: EMBED_SEND_MESSAGE, ...input })) return outcome;
  clearTimeout(timer);
  waiting.delete(input.requestId);
  return null;
}
