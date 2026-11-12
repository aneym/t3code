import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "./config.ts";
import { sweepStaleRuntimeTempDirectories } from "./runtimeTemp.ts";
import { forkParked } from "./serverActivation.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    yield* forkParked(sweepStaleRuntimeTempDirectories(config.baseDir));
  }),
);
