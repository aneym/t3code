// @effect-diagnostics nodeBuiltinImport:off -- Chromium needs a raw HTTP CONNECT proxy server.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { canonicalAddress, isBlockedAddress, isBlockedHost } from "./RemoteDeviceAddress.ts";

const REFUSED = "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

const pinnedAddress = async (host: string) => {
  const bare = host.replace(/^\[|\]$/gu, "");
  if (isBlockedHost(bare)) return undefined;
  const literal = canonicalAddress(bare);
  if (literal !== undefined) return literal;
  const resolved = await NodeDnsPromises.lookup(bare, { all: true, verbatim: true });
  const addresses = resolved.map((entry) => canonicalAddress(entry.address));
  if (addresses.length === 0) return undefined;
  if (addresses.some((address) => address === undefined || isBlockedAddress(address))) {
    return undefined;
  }
  return addresses[0];
};

const splitAuthority = (authority: string) => {
  const url = URL.parse(`http://${authority}/`);
  if (url === null || url.port === "") return undefined;
  return { host: url.hostname, port: Number(url.port) };
};

const tunnel = async (request: NodeHttp.IncomingMessage, client: NodeNet.Socket, head: Buffer) => {
  const target = splitAuthority(request.url ?? "");
  const address = target === undefined ? undefined : await pinnedAddress(target.host);
  if (target === undefined || address === undefined) {
    client.end(REFUSED);
    return;
  }
  const upstream = NodeNet.connect({ host: address, port: target.port }, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
};

const forward = async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
  const url = URL.parse(request.url ?? "");
  const address =
    url === null || url.protocol !== "http:" ? undefined : await pinnedAddress(url.hostname);
  if (url === null || address === undefined) {
    response.writeHead(403).end();
    return;
  }
  const headers = { ...request.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const upstream = NodeHttp.request(
    {
      host: address,
      port: url.port === "" ? 80 : Number(url.port),
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
    },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on("error", () => response.destroy());
  request.pipe(upstream);
};

let listening: Promise<number> | undefined;

export const port = () => {
  listening ??= new Promise<number>((resolve, reject) => {
    const server = NodeHttp.createServer((request, response) => {
      forward(request, response).catch(() => response.destroy());
    });
    server.on("connect", (request, client: NodeNet.Socket, head: Buffer) => {
      tunnel(request, client, head).catch(() => client.destroy());
    });
    server.on("upgrade", (_request, client: NodeNet.Socket) => client.destroy());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("No proxy port."));
      else resolve(address.port);
    });
  });
  return listening;
};
