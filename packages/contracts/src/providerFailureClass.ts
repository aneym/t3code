import * as Schema from "effect/Schema";

export const OrchestrationV2ProviderFailureClass = Schema.Literals([
  "usage_limit",
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type OrchestrationV2ProviderFailureClass = typeof OrchestrationV2ProviderFailureClass.Type;
