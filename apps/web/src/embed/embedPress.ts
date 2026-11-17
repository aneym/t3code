import { randomUUID } from "../lib/utils";
import { postToEmbedHost } from "./embedHost";
import { EMBED_PRESS_MESSAGE, type EmbedPress } from "./embedProtocol";

const PRESS_WAIT_MS = 1_500;
const PRESS_TOOLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["rails", new Set(["answer"])],
]);
const waiting = new Map<string, () => void>();
let hostListening = false;

export function applyEmbedHostPress(): void {
  hostListening = true;
}

export function applyEmbedPressResult(requestId: string): void {
  waiting.get(requestId)?.();
}

export function reportEmbedPress(press: EmbedPress): Promise<void> {
  if (!hostListening || PRESS_TOOLS.get(press.server)?.has(press.tool) !== true) {
    return Promise.resolve();
  }
  const requestId = `p_${randomUUID()}`;
  return new Promise((resolve) => {
    const settle = () => {
      clearTimeout(timer);
      waiting.delete(requestId);
      resolve();
    };
    const timer = setTimeout(settle, PRESS_WAIT_MS);
    waiting.set(requestId, settle);
    if (!postToEmbedHost({ type: EMBED_PRESS_MESSAGE, requestId, ...press })) settle();
  });
}
