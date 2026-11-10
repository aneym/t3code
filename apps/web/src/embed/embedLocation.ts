import { isEmbedPath } from "./embedProtocol";

const EMBED_PROVIDERS_SEGMENT = "providers";

export type EmbedLocation = {
  readonly environmentId: string;
  readonly threadId: string | null;
};

export function readEmbedLocation(pathname: string): EmbedLocation | null {
  if (!isEmbedPath(pathname)) return null;
  const [environmentId, view] = pathname.split("/").slice(2).map(decodeURIComponent);
  if (!environmentId) return null;
  return {
    environmentId,
    threadId: view && view !== EMBED_PROVIDERS_SEGMENT ? view : null,
  };
}
