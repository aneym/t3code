import { isChunkLoadError } from "./chunkReloadGuard";

const MAX_SUMMARY_CHARS = 200;
const MAX_PATH_CHARS = 60;
const URL_IN_MESSAGE = /\bhttps?:\/\/[^\s'"()]+/i;
const PRELOAD_CSS = /^Unable to preload CSS for (\S+)/;

export interface BootFailure {
  readonly summary: string;
  readonly probeUrl: string;
  readonly loadFailure: boolean;
}

function pathOf(url: string) {
  let path: string;
  try {
    path = new URL(url, window.location.href).pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? url;
  }
  return path.length > MAX_PATH_CHARS ? `.../${path.split("/").slice(-2).join("/")}` : path;
}

function failedResource() {
  try {
    for (const entry of performance.getEntriesByType("resource")) {
      const { responseStatus, initiatorType, name } = entry as PerformanceResourceTiming;
      if (initiatorType === "fetch" || initiatorType === "xmlhttprequest") continue;
      if (typeof responseStatus === "number" && responseStatus >= 400) {
        return { url: name, status: responseStatus };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

function failedUrlIn(error: unknown, entryUrl: string) {
  const message = messageOf(error);
  const css = PRELOAD_CSS.exec(message)?.[1];
  if (css) return css;
  return isChunkLoadError(error) ? (URL_IN_MESSAGE.exec(message)?.[0] ?? entryUrl) : null;
}

export async function probe(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    return response.status;
  } catch {
    return null;
  }
}

function errorLine(error: unknown) {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "unknown error";
  const plain = text.replace(/\bhttps?:\/\/[^\s/'"()]+/gi, "").replace(/[?#]\S*/g, "");
  return plain.length > MAX_SUMMARY_CHARS ? `${plain.slice(0, MAX_SUMMARY_CHARS)}...` : plain;
}

export function filesUnreachable(status: number | null, url: string) {
  return status === null
    ? `Could not load the app files: no response from ${pathOf(url)}.`
    : `Could not load the app files: HTTP ${status} from ${pathOf(url)}.`;
}

export async function describeBootFailure(error: unknown, entryUrl: string): Promise<BootFailure> {
  const url = failedUrlIn(error, entryUrl);
  if (!url) {
    return {
      summary: `Startup stopped with an error: ${errorLine(error)}`,
      probeUrl: entryUrl,
      loadFailure: false,
    };
  }
  const resource = failedResource();
  if (resource) {
    return {
      summary: filesUnreachable(resource.status, resource.url),
      probeUrl: resource.url,
      loadFailure: true,
    };
  }
  const status = await probe(url);
  return {
    summary:
      status !== null && status < 400
        ? `Could not load the app files: ${pathOf(url)} failed to load.`
        : filesUnreachable(status, url),
    probeUrl: url,
    loadFailure: true,
  };
}
