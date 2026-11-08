import * as Schema from "effect/Schema";

export const ProviderPermissionDenial = Schema.Struct({
  toolName: Schema.String,
  toolUseId: Schema.String,
});
export type ProviderPermissionDenial = typeof ProviderPermissionDenial.Type;
