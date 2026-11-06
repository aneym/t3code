import { isPublicFaviconHost } from "@t3tools/shared/hostClassification";

export function publicTabUrl(rawUrl: string): string | null {
  const url = URL.parse(rawUrl);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  return isPublicFaviconHost(url.hostname) ? url.href : null;
}
