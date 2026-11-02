import { WS_METHODS } from "@t3tools/contracts";
import { ServerHandoffProbe } from "@t3tools/contracts/serverLifecycle";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { RpcServer } from "effect/rpc";
import { acknowledgeHandoff } from "./serverHandoffDelivery.ts";
import { withTerminalOutputWindow } from "./terminal/OutputProtocol.ts";

const isHandoffProbe = Schema.is(ServerHandoffProbe);
const pending = new Set<Deferred.Deferred<void>>();
let closing = false;

export const flushHandoffResponses = Effect.fn("serverHandoffProtocol.flushResponses")(function (
  budgetMs: number,
) {
  closing = true;
  return Effect.forEach([...pending], Deferred.await, {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.timeoutOption(budgetMs));
});

export const handoffRpc = Effect.fn("serverHandoffProtocol.make")(function* () {
  const { protocol: socketProtocol, httpEffect } =
    yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
  const protocol = withTerminalOutputWindow(socketProtocol);
  const confirmations = new Map<
    string,
    { input: typeof ServerHandoffProbe.Type; written: Deferred.Deferred<void> }
  >();
  const complete = (key: string) =>
    Effect.suspend(() => {
      const confirmation = confirmations.get(key);
      if (confirmation === undefined) return Effect.void;
      confirmations.delete(key);
      pending.delete(confirmation.written);
      return Deferred.succeed(confirmation.written, undefined).pipe(Effect.asVoid);
    });
  return {
    httpEffect: httpEffect.pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach([...confirmations.keys()], complete, { discard: true }),
        ),
      ),
    ),
    protocol: {
      ...protocol,
      run: (write) =>
        protocol.run((clientId, message) => {
          if (
            message._tag === "Request" &&
            message.tag === WS_METHODS.serverProbe &&
            isHandoffProbe(message.payload) &&
            message.payload.handoffReplyReceived === true
          ) {
            if (closing) return Effect.void;
            const written = Deferred.makeUnsafe<void>();
            pending.add(written);
            confirmations.set(`${clientId}:${message.id}`, { input: message.payload, written });
          }
          return write(clientId, message);
        }),
      send: (clientId, response, transferables) =>
        protocol.send(clientId, response, transferables).pipe(
          Effect.andThen(() => {
            if (response._tag !== "Exit") return Effect.void;
            const key = `${clientId}:${response.requestId}`;
            const confirmation = confirmations.get(key);
            return confirmation !== undefined && response.exit._tag === "Success"
              ? acknowledgeHandoff(confirmation.input, true).pipe(Effect.asVoid)
              : Effect.void;
          }),
          Effect.ensuring(
            Effect.suspend(() =>
              response._tag === "Exit"
                ? complete(`${clientId}:${response.requestId}`)
                : Effect.void,
            ),
          ),
        ),
    } satisfies RpcServer.Protocol["Service"],
  };
});
