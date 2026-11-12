import {
  armServiceRecoveryDeadline,
  clearServiceRecoveryDeadline,
} from "./serviceLauncherExitDeadline.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Node HTTP and IPC handles are application boundaries.
import { admitHttpRequest } from "./serverHandoffBarrier.ts";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpMiddleware, HttpServerRequest } from "effect/http";
import * as Socket from "effect/socket/Socket";
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
let ingressAccepted = false;
export const serviceBootTimeline = {
  now: Clock.currentTimeMillis,
  prewarmMs: 0,
  acquireAt: 0,
  ownershipAt: 0,
  layersAt: 0,
  validatedAt: 0,
};

export const hotSwapProtocolAccepted = () => ingressAccepted;

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

export const exchangeServiceMessage = Effect.fn("serviceChildTransport.exchange")(function* (
  message: ServiceLauncherChildMessage,
  accept: (reply: ServiceLauncherParentMessage) => boolean,
) {
  const clock = yield* Clock.Clock;
  return yield* Effect.callback<ServiceLauncherParentMessage, ServiceLauncherClientError>(
    (resume) => {
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
        if (reply !== undefined && accept(reply)) {
          if (reply.type === "ingress-bound") ingressAccepted = true;
          if (reply.type === "acquire")
            serviceBootTimeline.acquireAt = clock.currentTimeMillisUnsafe();
          finish(Effect.succeed(reply));
        }
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
    },
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 minutes",
      orElse: () => Effect.fail(new ServiceLauncherClientError({ operation: "timeout" })),
    }),
  );
});

let listener: NodeHttp.Server | undefined;
let privatePort = 0;
let prepared = false;
export const descriptorDuringRecovery = () => prepared && hotSwapContext()?.hotSwap?.warm === true;
let frozen = false;
const connections = new Set<NodeNet.Socket>();
const webSockets = new Map<NodeNet.Socket, Effect.Effect<void, Socket.SocketError>>();

export const handoff = HttpMiddleware.make((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (hotSwapContext() === undefined || !(request.source instanceof NodeHttp.IncomingMessage))
      return yield* httpEffect;
    const raw = request.source.socket;
    const upgrade = request.upgrade.pipe(
      Effect.tap((socket) =>
        Effect.gen(function* () {
          const writer = yield* socket.writer;
          webSockets.set(raw, writer.write(new Socket.CloseEvent(1012, "service restart")));
          raw.once("close", () => webSockets.delete(raw));
        }),
      ),
    );
    return yield* Effect.provideService(
      httpEffect,
      HttpServerRequest.HttpServerRequest,
      new Proxy(request, {
        get: (target, key) => (key === "upgrade" ? upgrade : Reflect.get(target, key, target)),
      }),
    );
  }),
);

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
    serviceBootTimeline.validatedAt = yield* Clock.currentTimeMillis;
    prepared = true;
    const pending = context.update?.status === "pending" ? context.update : undefined;
    if (pending !== undefined) {
      yield* exchangeServiceMessage(
        {
          type: "validated",
          updateId: pending.id,
          port: privatePort,
          recovering: context.hotSwap?.warm === true,
          reportsCommandReady: true,
        },
        (reply) => reply.type === "committed" && reply.updateId === pending.id,
      );
      if (context.hotSwap?.warm === true) yield* Effect.sync(armServiceRecoveryDeadline);
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

export const freezeServiceConnections = Effect.fn("serviceChildTransport.freezeConnections")(
  function* (flushMs: number) {
    frozen = true;
    prepared = false;
    listener?.closeIdleConnections();
    for (const socket of connections) {
      if (!webSockets.has(socket)) socket.end();
    }
    yield* Effect.forEach(
      [...webSockets],
      ([socket, close]) =>
        Effect.callback<void>((resume) => {
          if (socket.destroyed) return resume(Effect.void);
          const onClose = () => resume(Effect.void);
          socket.once("close", onClose);
          return Effect.sync(() => socket.off("close", onClose));
        }).pipe(Effect.raceFirst(close.pipe(Effect.andThen(Effect.never))), Effect.ignore),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.timeoutOption(flushMs), Effect.ignore);
    for (const socket of connections) socket.end();
  },
);

export const serviceCommandReady = Effect.gen(function* () {
  yield* Effect.sync(clearServiceRecoveryDeadline);
  const { prewarmMs, acquireAt, ownershipAt, layersAt, validatedAt } = serviceBootTimeline;
  if (acquireAt !== 0)
    yield* Effect.logInfo("Service handoff boot timeline", {
      prewarmMs,
      acquireToOwnershipMs: ownershipAt - acquireAt,
      acquireToLayersMs: layersAt - acquireAt,
      acquireToValidatedMs: validatedAt - acquireAt,
      acquireToReadyMs: (yield* Clock.currentTimeMillis) - acquireAt,
    });
  if (descriptorDuringRecovery())
    yield* sendServiceMessage({ type: "listening", port: privatePort });
});
