import type { EnvironmentId } from "@t3tools/contracts";
import { isLoopbackAddressHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import { readPreparedConnection } from "~/state/session";

const isWebUrl = (url: URL) => url.protocol === "http:" || url.protocol === "https:";

export function remoteLoopbackHost(environmentId: EnvironmentId): string | undefined {
  const connection = readPreparedConnection(environmentId);
  const server = connection ? URL.parse(connection.httpBaseUrl) : null;
  if (!server || isLoopbackAddressHost(server.hostname)) return undefined;
  return isPrivateNetworkHost(server.hostname) ? server.hostname : undefined;
}

export function resolveRemoteTabUrl(environmentId: EnvironmentId, rawUrl: string): string | null {
  const url = URL.parse(rawUrl);
  if (!url || !isWebUrl(url)) return null;
  if (!isLoopbackAddressHost(url.hostname)) return url.href;
  const host = remoteLoopbackHost(environmentId);
  if (host === undefined) return null;
  url.hostname = host;
  return isWebUrl(url) && !isLoopbackAddressHost(url.hostname) ? url.href : null;
}
