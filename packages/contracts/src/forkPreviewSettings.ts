import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ForkPreviewSettingsFields = {
  previewOpenOnUserDevice: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};

export const ForkPreviewSettingsPatchFields = {
  previewOpenOnUserDevice: Schema.optionalKey(Schema.Boolean),
};

export const ForkPreviewClientSettingsFields = {
  browserAllowRemoteDeviceTabs: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  browserAllowRemoteDeviceControl: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
};

export const ForkPreviewClientSettingsPatchFields = {
  browserAllowRemoteDeviceTabs: Schema.optionalKey(Schema.Boolean),
  browserAllowRemoteDeviceControl: Schema.optionalKey(Schema.Boolean),
};
