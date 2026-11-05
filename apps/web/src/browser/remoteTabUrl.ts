import type { EnvironmentId } from "@t3tools/contracts";
import { isLoopbackAddressHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import { readPreparedConnection } from "~/state/session";

const isWebUrl = (url: URL) => url.protocol === "http:" || url.protocol === "https:";

export function resolveRemoteTabUrl(environmentId: EnvironmentId, rawUrl: string): string | null {
  const url = URL.parse(rawUrl);
  if (!url || !isWebUrl(url)) return null;
  if (!isLoopbackAddressHost(url.hostname)) return url.href;
  const connection = readPreparedConnection(environmentId);
  const server = connection ? URL.parse(connection.httpBaseUrl) : null;
  if (!server || isLoopbackAddressHost(server.hostname)) return null;
  if (!isPrivateNetworkHost(server.hostname)) return null;
  url.hostname = server.hostname;
  return isWebUrl(url) && !isLoopbackAddressHost(url.hostname) ? url.href : null;
}
