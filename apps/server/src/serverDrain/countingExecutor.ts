import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEffectExecutorV2 } from "../orchestration-v2/EffectWorker.ts";
import { ServerDrain } from "./ServerDrain.ts";

export const layerCountingTurnStarts = Layer.effect(
  OrchestrationEffectExecutorV2,
  Effect.gen(function* () {
    const executor = yield* OrchestrationEffectExecutorV2;
    const drain = yield* ServerDrain;
    return OrchestrationEffectExecutorV2.of({
      execute: Effect.fn("ServerDrain.countTurnStart")(function* (effect, options) {
        const run = executor.execute(effect, options);
        return yield* effect.request.type === "provider-turn.start"
          ? drain.countTurnStart(run)
          : run;
      }),
    });
  }),
);
