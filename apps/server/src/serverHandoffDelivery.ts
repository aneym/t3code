import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

const clients = new Map<
  string,
  {
    offered: number | undefined;
    acknowledged: number;
    signal: Deferred.Deferred<void>;
  }
>();

export const registerHandoffClient = Effect.fn("ServerHandoffDelivery.register")(function* (
  id: string | undefined,
) {
  if (id === undefined) return;
  const client = { offered: undefined, acknowledged: 0, signal: yield* Deferred.make<void>() };
  yield* Effect.acquireRelease(
    Effect.sync(() => clients.set(id, client)),
    () =>
      Deferred.succeed(client.signal, undefined).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (clients.get(id) === client) clients.delete(id);
          }),
        ),
      ),
  );
});

export const acknowledgeHandoff = Effect.fn("ServerHandoffDelivery.acknowledge")(function* (input: {
  readonly handoffClientId?: string;
  readonly handoffSequence?: number;
  readonly handoffReplyReceived?: boolean;
}) {
  const client =
    input.handoffClientId === undefined ? undefined : clients.get(input.handoffClientId);
  if (client !== undefined && input.handoffSequence !== undefined) {
    if (input.handoffReplyReceived === true) {
      if (client.offered === input.handoffSequence) {
        client.acknowledged = input.handoffSequence;
        yield* Deferred.succeed(client.signal, undefined);
      }
    } else client.offered = input.handoffSequence;
  }
  return {};
});

export const awaitHandoffReceipts = Effect.fn("ServerHandoffDelivery.awaitReceipts")(function* (
  sequence: number,
  budgetMs: number,
) {
  yield* Effect.forEach(
    [...clients.values()],
    (client) => (client.acknowledged >= sequence ? Effect.void : Deferred.await(client.signal)),
    { concurrency: "unbounded", discard: true },
  ).pipe(Effect.timeoutOption(Math.min(budgetMs / 4, 5_000)));
});
