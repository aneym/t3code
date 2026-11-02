import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";

import { hotSwapContext } from "./serviceChildTransport.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const READ_ONLY_DURING_RECOVERY: ReadonlySet<string> = new Set<
  RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"]
>([
  WS_METHODS.serverProbe,
  WS_METHODS.serverGetConfig,
  WS_METHODS.subscribeServerConfig,
  ORCHESTRATION_V2_WS_METHODS.subscribeShell,
  ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  ORCHESTRATION_V2_WS_METHODS.getThreadFamily,
  ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads,
  ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds,
  WS_METHODS.projectsListEntries,
  WS_METHODS.projectsListIgnoredFiles,
  WS_METHODS.projectsReadFile,
]);

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>;
type Handler = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown> | Stream.Stream<unknown>;

const withPhase = (value: unknown, recovering: boolean) => {
  if (typeof value !== "object" || value === null) return value;
  const recoveryPhase = recovering ? "recovering" : "ready";
  if ("kind" in value && value.kind === "snapshot" && "snapshot" in value)
    return { ...value, snapshot: { ...(value.snapshot as object), recoveryPhase } };
  if ("type" in value && value.type === "snapshot" && "config" in value)
    return { ...value, config: { ...(value.config as object), recoveryPhase } };
  return { ...value, recoveryPhase };
};

export const gateRecoveryHandlers = Effect.fn("wsRecoveryGate.handlers")(function* <
  H extends Handlers,
>(handlers: H) {
  if (hotSwapContext()?.hotSwap?.warm !== true) return handlers;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const ready = yield* Ref.make(false);
  const awaitReady = startup.awaitCommandReady.pipe(Effect.orDie);
  yield* Effect.forkScoped(awaitReady.pipe(Effect.andThen(Ref.set(ready, true))), {
    startImmediately: true,
  });
  return new Proxy(handlers, {
    get(target, key, receiver) {
      const handler = Reflect.get(target, key, receiver) as Handler;
      if (typeof key !== "string" || typeof handler !== "function") return handler;
      return (...args: ReadonlyArray<unknown>) => {
        const invoke = () => handler(...args);
        if (key === ORCHESTRATION_V2_WS_METHODS.subscribeShell) {
          return Stream.fromEffect(Ref.get(ready)).pipe(
            Stream.flatMap((isReady) =>
              isReady
                ? Stream.make(true)
                : Stream.concat(
                    Stream.make(false),
                    Stream.fromEffect(awaitReady.pipe(Effect.as(true))),
                  ),
            ),
            Stream.switchMap((isReady) => {
              const input = args[0] as object;
              const stream = handler(
                isReady ? { ...input, afterSequence: undefined } : input,
                ...args.slice(1),
              ) as Stream.Stream<unknown>;
              return stream.pipe(Stream.map((item) => withPhase(item, !isReady)));
            }),
          );
        }
        if (!READ_ONLY_DURING_RECOVERY.has(key)) {
          const rpc = WsRpcGroup.requests.get(key);
          return rpc !== undefined && RpcSchema.isStreamSchema(rpc.successSchema)
            ? Stream.unwrap(awaitReady.pipe(Effect.map(() => invoke() as Stream.Stream<unknown>)))
            : awaitReady.pipe(Effect.andThen(() => invoke() as Effect.Effect<unknown>));
        }
        const result = invoke();
        if (
          key !== WS_METHODS.serverGetConfig &&
          key !== WS_METHODS.subscribeServerConfig &&
          key !== ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot
        )
          return result;
        const annotate = (value: unknown) =>
          Ref.get(ready).pipe(Effect.map((isReady) => withPhase(value, !isReady)));
        return Stream.isStream(result)
          ? result.pipe(Stream.mapEffect(annotate))
          : result.pipe(Effect.flatMap(annotate));
      };
    },
  });
});
