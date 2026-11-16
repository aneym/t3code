import { CLIENT_EXTRAS_MANIFEST_FILE } from "@t3tools/shared/clientExtras";

export type ClientExtrasState = "ready" | "unavailable";

let probe: Promise<ClientExtrasState> | undefined;

async function firstListedFile(): Promise<string | undefined> {
  const response = await fetch(`/${CLIENT_EXTRAS_MANIFEST_FILE}`, { cache: "no-store" });
  if (!response.ok) return undefined;
  const manifest: unknown = await response.json();
  if (typeof manifest !== "object" || manifest === null || !("files" in manifest)) return undefined;
  const files = manifest.files;
  if (typeof files !== "object" || files === null) return undefined;
  return Object.keys(files)[0];
}

async function waitForClientExtras(): Promise<ClientExtrasState> {
  const listed = await firstListedFile().catch(() => undefined);
  if (listed === undefined) return "ready";
  while (true) {
    const response = await fetch(`/${listed}`, { method: "HEAD", cache: "no-store" }).catch(
      () => undefined,
    );
    if (response?.status !== 503) return response?.ok ? "ready" : "unavailable";
    const seconds = Number(response.headers.get("retry-after"));
    await new Promise((resolve) => setTimeout(resolve, (seconds > 0 ? seconds : 2) * 1000));
  }
}

/** Resolves once the server holds the Office viewer's fonts and engines, downloading them on first use. */
export function clientExtrasReady(): Promise<ClientExtrasState> {
  probe ??= waitForClientExtras();
  return probe;
}

export function retryClientExtras(): void {
  probe = undefined;
}
