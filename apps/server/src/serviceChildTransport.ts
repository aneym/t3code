// @effect-diagnostics nodeBuiltinImport:off -- Node HTTP and IPC handles are application boundaries.
import { admitHttpRequest } from "./serverHandoffBarrier.ts";
import type * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import {
  decodeServiceLauncherContext,
  unsupportedServiceHotSwap,
  decodeServiceLauncherParentMessage,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
} from "./cloud/serviceProtocol.ts";
import { ServiceLauncherClientError } from "./cloud/serviceLauncherErrors.ts";

let attachedContext: ReturnType<typeof decodeServiceLauncherContext>;

export function hotSwapContext() {
  if (attachedContext !== undefined) return attachedContext;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native IPC capability is inspected outside an Effect runtime.
  if (process.platform === "win32" || !process.connected || process.send === undefined)
    return undefined;
  const raw = process.env[SERVICE_LAUNCHER_CONTEXT_ENV] ?? "";
  if (unsupportedServiceHotSwap(raw)) {
    process.send({ type: "capability-rejected", reason: "unsupported-hot-swap" });
    throw new Error("Unsupported service hot-swap capability; maintenance restart required.");
  }
  const context = decodeServiceLauncherContext(raw);
  attachedContext = context?.hotSwap === undefined ? undefined : context;
  return attachedContext;
}

export const exchangeServiceMessage = Effect.fn("serviceChildTransport.exchange")(function (
  message: ServiceLauncherChildMessage,
  accept: (reply: ServiceLauncherParentMessage) => boolean,
) {
  return Effect.callback<ServiceLauncherParentMessage, ServiceLauncherClientError>((resume) => {
    let settled = false;
    const cleanup = () => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const finish = (
      result: Effect.Effect<ServiceLauncherParentMessage, ServiceLauncherClientError>,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(result);
    };
    const onMessage = (value: unknown) => {
      const reply = decodeServiceLauncherParentMessage(value);
      if (reply !== undefined && accept(reply)) finish(Effect.succeed(reply));
    };
    const onDisconnect = () =>
      finish(Effect.fail(new ServiceLauncherClientError({ operation: "disconnect" })));
    process.on("message", onMessage);
    process.on("disconnect", onDisconnect);
    try {
      if (process.send === undefined) onDisconnect();
      else
        process.send(message, (cause) => {
          if (cause !== null)
            finish(Effect.fail(new ServiceLauncherClientError({ operation: "send", cause })));
        });
    } catch (cause) {
      finish(Effect.fail(new ServiceLauncherClientError({ operation: "send", cause })));
    }
    return Effect.sync(cleanup);
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 minutes",
      orElse: () => Effect.fail(new ServiceLauncherClientError({ operation: "timeout" })),
    }),
  );
});

let listener: NodeHttp.Server | undefined;
let privatePort = 0;
let prepared = false;
let frozen = false;
const connections = new Set<NodeNet.Socket>();

export function attachServiceIngress<T extends NodeHttp.Server>(server: T, publicPort: number): T {
  const context = hotSwapContext();
  if (context === undefined) return server;
  listener = server;
  const actualAddress = server.address.bind(server);
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  const emit = server.emit;
  server.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === "request") {
      const request = args[0] as NodeHttp.IncomingMessage;
      const response = args[1] as NodeHttp.ServerResponse;
      if (request.url === "/__t3_service_health" && request.socket.localPort === privatePort) {
        response.writeHead(prepared && !frozen ? 200 : 503, {
          "content-type": "application/json",
          connection: "close",
        });
        response.end(
          JSON.stringify({
            instanceId: context.hotSwap?.instanceId,
            updateId: context.update?.id,
            pid: process.pid,
          }),
        );
        return true;
      }
      if (frozen || !admitHttpRequest(response)) {
        response.writeHead(503, { connection: "close" }).end();
        return true;
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  };
  const onMessage = (value: unknown, socket: unknown) => {
    const message = decodeServiceLauncherParentMessage(value);
    if (message?.type !== "socket" || !(socket instanceof NodeNet.Socket)) return;
    if (frozen) {
      socket.pause();
      const buffered: unknown = socket.read(socket.readableLength);
      const prefix = Buffer.concat([
        Buffer.from(message.prefix ?? "", "base64"),
        Buffer.isBuffer(buffered) ? buffered : Buffer.alloc(0),
      ]).toString("base64");
      process.send?.({ type: "socket-returned", transferId: message.transferId, prefix });
      socket.destroy();
      return;
    }
    if (message.prefix) socket.unshift(Buffer.from(message.prefix, "base64"));
    socket.on("error", () => socket.destroy());
    server.emit("connection", socket);
    process.send?.({ type: "socket-accepted", transferId: message.transferId }, (error) => {
      if (error === null) socket.resume();
      else socket.destroy();
    });
  };
  process.on("message", onMessage);
  process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
  server.once("close", () => process.off("message", onMessage));
  server.once("listening", () => {
    const address = actualAddress();
    if (address !== null && typeof address !== "string") privatePort = address.port;
  });
  server.address = () => {
    const address = actualAddress();
    return address === null || typeof address === "string"
      ? address
      : {
          ...address,
          address: context.hotSwap?.publicHost ?? address.address,
          port: context.hotSwap?.publicPort ?? publicPort,
        };
  };
  return server;
}

export const prepareServiceRouting = Effect.fn("serviceChildTransport.prepareRouting")(
  function* () {
    const context = hotSwapContext();
    if (context === undefined) return undefined;
    prepared = true;
    const pending = context.update?.status === "pending" ? context.update : undefined;
    if (pending !== undefined) {
      yield* exchangeServiceMessage(
        { type: "validated", updateId: pending.id, port: privatePort },
        (reply) => reply.type === "committed" && reply.updateId === pending.id,
      );
      return {
        id: pending.id,
        fromVersion: pending.fromVersion,
        targetVersion: pending.targetVersion,
        status: "committed" as const,
      };
    }
    yield* sendServiceMessage({ type: "listening", port: privatePort });
    return context.update?.status === "pending" ? undefined : context.update;
  },
);

export const sendServiceMessage = Effect.fn("serviceChildTransport.send")(function (
  message: ServiceLauncherChildMessage,
) {
  return Effect.callback<void, ServiceLauncherClientError>((resume) => {
    try {
      if (process.send === undefined)
        resume(Effect.fail(new ServiceLauncherClientError({ operation: "unmanaged" })));
      else
        process.send(message, (cause) =>
          resume(
            cause === null
              ? Effect.void
              : Effect.fail(new ServiceLauncherClientError({ operation: "send", cause })),
          ),
        );
    } catch (cause) {
      resume(Effect.fail(new ServiceLauncherClientError({ operation: "send", cause })));
    }
  });
});

export function freezeServiceConnections(): void {
  frozen = true;
  prepared = false;
  listener?.closeIdleConnections();
  for (const socket of connections) socket.end();
}
