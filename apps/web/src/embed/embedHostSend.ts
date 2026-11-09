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

export function sendThroughEmbedHost(input: {
  readonly thread: string;
  readonly requestId: string;
  readonly text: string;
  readonly when: EmbedSendWhen;
}): Promise<EmbedSendOutcome> | null {
  if (!hostSends) return null;
  const outcome = new Promise<EmbedSendOutcome>((resolve) => waiting.set(input.requestId, resolve));
  if (postToEmbedHost({ type: EMBED_SEND_MESSAGE, ...input })) return outcome;
  waiting.delete(input.requestId);
  return null;
}
