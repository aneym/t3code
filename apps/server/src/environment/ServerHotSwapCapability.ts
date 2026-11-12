import type { ServerSelfUpdateCapability } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { hotSwapContext, hotSwapProtocolAccepted } from "../serviceChildTransport.ts";
import { readLauncherIngressConfig } from "../serviceLauncherConfig.ts";

export const resolveServerHotSwapCapability = Effect.fn("ServerEnvironment.hotSwapCapability")(
  function* (selfUpdate: ServerSelfUpdateCapability | null, baseDir: string) {
    if (
      selfUpdate !== "boot-service" ||
      hotSwapContext() === undefined ||
      !hotSwapProtocolAccepted()
    )
      return {};
    const config = yield* Effect.promise(() =>
      readLauncherIngressConfig(baseDir).catch(() => undefined),
    );
    return config === undefined ? {} : { serverHotSwap: true as const };
  },
);
