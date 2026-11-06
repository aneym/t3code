import { isLoopbackAddressHost, isPublicFaviconHost } from "@t3tools/shared/hostClassification";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

export const canonicalAddress = (host: string) => {
  const bare = host
    .replace(/^\[|\]$/gu, "")
    .replace(/%.*$/u, "")
    .toLowerCase();
  const family = NodeNet.isIP(bare);
  if (family === 0) return undefined;
  const parsed = URL.parse(`http://${family === 6 ? `[${bare}]` : bare}/`)?.hostname.replace(
    /^\[|\]$/gu,
    "",
  );
  if (!parsed) return undefined;
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(parsed);
  if (!mapped) return parsed;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
};

const ownAddresses = () =>
  new Set(
    Object.values(NodeOS.networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .flatMap((entry) => {
        const address = canonicalAddress(entry.address);
        return address === undefined ? [] : [address];
      }),
  );

export const isBlockedAddress = (address: string) =>
  !isPublicFaviconHost(address) || ownAddresses().has(address);

export const isBlockedHost = (hostname: string) => {
  if (isLoopbackAddressHost(hostname)) return true;
  const address = canonicalAddress(hostname);
  return address !== undefined && isBlockedAddress(address);
};
