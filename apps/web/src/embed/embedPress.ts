import { randomUUID } from "../lib/utils";
import { postToEmbedHost } from "./embedHost";
import { EMBED_PRESS_MESSAGE, type EmbedPress } from "./embedProtocol";

const PRESS_WAIT_MS = 1_500;
const PRESS_TOOLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["rails", new Set(["answer"])],
]);
const waiting = new Map<string, (witnessed: boolean) => void>();
let hostListening = false;

export function applyEmbedHostPress(): void {
  hostListening = true;
}

export function applyEmbedPressResult(requestId: string, witnessed: boolean): void {
  waiting.get(requestId)?.(witnessed);
}

export const embedPressHeard = (server: string, tool: string): boolean =>
  hostListening && PRESS_TOOLS.get(server)?.has(tool) === true;

export function reportEmbedPress(press: EmbedPress): Promise<boolean> {
  if (!embedPressHeard(press.server, press.tool)) return Promise.resolve(false);
  const requestId = `p_${randomUUID()}`;
  return new Promise((resolve) => {
    const settle = (witnessed: boolean) => {
      clearTimeout(timer);
      waiting.delete(requestId);
      resolve(witnessed);
    };
    const timer = setTimeout(() => settle(false), PRESS_WAIT_MS);
    waiting.set(requestId, settle);
    if (!postToEmbedHost({ type: EMBED_PRESS_MESSAGE, requestId, ...press })) settle(false);
  });
}
