import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as RpcClient from "effect/rpc/RpcClient";

export const interruptibleTransport = (
  protocol: RpcClient.Protocol["Service"],
  closed: Deferred.Deferred<void>,
): RpcClient.Protocol["Service"] => ({
  ...protocol,
  send: (clientId, request, transferables) =>
    request._tag === "Interrupt"
      ? Effect.raceFirst(protocol.send(clientId, request, transferables), Deferred.await(closed))
      : protocol.send(clientId, request, transferables),
});
