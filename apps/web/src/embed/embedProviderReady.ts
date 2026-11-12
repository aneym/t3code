import type { ProviderInstanceEntry } from "../providerInstances";
import { inEmbedPage } from "./embedProtocol";

function canStartTurn(entry: ProviderInstanceEntry): boolean {
  return (
    entry.enabled &&
    entry.isAvailable &&
    entry.installed &&
    entry.status !== "error" &&
    entry.status !== "disabled" &&
    entry.snapshot.auth.status !== "unauthenticated"
  );
}

export function embedNeedsProvider(
  configLoaded: boolean,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): boolean {
  return configLoaded && inEmbedPage() && !entries.some(canStartTurn);
}
