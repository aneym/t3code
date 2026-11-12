import * as Layer from "effect/Layer";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";

export const layer = Layer.mergeAll(
  ProviderAdapterRegistry.layerFromProviderInstanceRegistry,
  ProviderContinuationRequests.layer,
);
