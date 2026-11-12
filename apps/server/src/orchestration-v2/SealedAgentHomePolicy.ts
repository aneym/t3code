import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { sealedAgentHomeFor } from "../agents/SealedAgentHome.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const SEALABLE_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

export const layer: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  RuntimePolicy.RuntimePolicyV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicy.RuntimePolicyV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveSealedAgentHome")(function* (input) {
        const policy = yield* base.resolve(input);
        const refuse = (reason: string) =>
          new RuntimePolicy.RuntimePolicySealedAgentHomeError({
            threadId: input.thread.id,
            reason,
          });
        const sealed = yield* Effect.tryPromise({
          try: () => sealedAgentHomeFor(policy.cwd),
          catch: (cause) => refuse(cause instanceof Error ? cause.message : String(cause)),
        });
        if (sealed === null) return policy;
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        if (instance === undefined || !SEALABLE_DRIVERS.has(instance.driverKind))
          return yield* refuse(
            `${sealed.home} is a sealed agent home, and only Claude threads can run sealed today. Switch this thread to Claude to continue.`,
          );
        return policy;
      }),
    });
  }),
);
