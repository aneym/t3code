// @effect-diagnostics nodeBuiltinImport:off -- Raw response admission is a Node HTTP boundary.
import type * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { hotSwapContext } from "./serviceChildTransport.ts";

const admittedExecution = Context.Reference<{ active: boolean } | undefined>("t3/serverAdmission", {
  defaultValue: () => undefined,
});
const responses = new Set<NodeHttp.ServerResponse>();
let frozen = false;
let admitted = 0;
let idle = Promise.withResolvers<void>();

const leave = () => {
  admitted -= 1;
  if (frozen && admitted === 0) idle.resolve();
};

export function admitHttpRequest(response: NodeHttp.ServerResponse): boolean {
  if (hotSwapContext() === undefined) return true;
  if (frozen) return false;
  admitted += 1;
  responses.add(response);
  let left = false;
  const finish = () => {
    if (!left) {
      left = true;
      responses.delete(response);
      leave();
    }
  };
  response.once("finish", finish);
  response.once("close", finish);
  return true;
}

export const withServerAdmission = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  hotSwapContext() === undefined
    ? effect
    : Effect.gen(function* () {
        if ((yield* admittedExecution)?.active) return yield* effect;
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            if (frozen) return undefined;
            admitted += 1;
            return { active: true };
          }),
          (accepted) =>
            accepted
              ? Effect.provideService(effect, admittedExecution, accepted)
              : Effect.interrupt,
          (accepted) =>
            accepted
              ? Effect.sync(() => {
                  accepted.active = false;
                  leave();
                })
              : Effect.void,
        );
      });

export const freezeServerAdmissions = Effect.fn("serverHandoffBarrier.freeze")(function* () {
  yield* Effect.sync(() => {
    frozen = true;
    for (const response of responses) {
      const contentType = response.getHeader("content-type");
      if (typeof contentType === "string" && contentType.includes("text/event-stream"))
        response.end();
    }
    if (admitted === 0) idle.resolve();
  });
  yield* Effect.promise(() => idle.promise);
});

export function reopenServerAdmissions(): void {
  frozen = false;
  idle = Promise.withResolvers<void>();
}
