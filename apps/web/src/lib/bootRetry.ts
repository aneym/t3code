import { describeBootFailure, filesUnreachable, probe } from "./bootFailure";
import { showBootError } from "./bootError";

const RETRY_KEY = "t3code:boot-retry";
const SILENT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
const RETRY_WINDOW_MS = 10 * 60_000;
const LOAD_RETRY_SECONDS = 15;
const ERROR_RETRY_SECONDS = 30;

function nextSilentAttempt(now: number) {
  try {
    const [count = 0, last = 0] = (sessionStorage.getItem(RETRY_KEY) ?? "").split(":").map(Number);
    const attempt = now - last > RETRY_WINDOW_MS ? 0 : count;
    sessionStorage.setItem(RETRY_KEY, `${attempt + 1}:${now}`);
    return attempt < SILENT_DELAYS_MS.length ? attempt : null;
  } catch {
    return null;
  }
}

export function clearBootRetry() {
  try {
    sessionStorage.removeItem(RETRY_KEY);
  } catch {
    return;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function reloadWhenReachable(url: string) {
  const status = await probe(url);
  if (status !== null && status < 400) {
    window.location.reload();
    return null;
  }
  return filesUnreachable(status, url);
}

export async function recoverFromBootFailure(error: unknown) {
  if (window.desktopBridge) return showBootError(error);
  const entryUrl = import.meta.url;
  const failure = await describeBootFailure(error, entryUrl).catch(() => null);
  const probeUrl = failure?.probeUrl ?? entryUrl;
  for (let attempt = nextSilentAttempt(Date.now()); attempt !== null;) {
    console.warn(`T3 Code failed to start, trying again (${attempt + 1}).`, error);
    await wait(SILENT_DELAYS_MS[attempt] ?? 0);
    if ((await reloadWhenReachable(probeUrl)) === null) return;
    attempt = nextSilentAttempt(Date.now());
  }
  showBootError(error, {
    summary: failure?.summary ?? null,
    everySeconds: failure?.loadFailure === false ? ERROR_RETRY_SECONDS : LOAD_RETRY_SECONDS,
    tryAgain: () => reloadWhenReachable(probeUrl),
  });
}
