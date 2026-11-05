import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ForkPreviewSettingsFields = {
  previewOpenOnUserDevice: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};

export const ForkPreviewSettingsPatchFields = {
  previewOpenOnUserDevice: Schema.optionalKey(Schema.Boolean),
};
