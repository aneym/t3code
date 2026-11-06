import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const Server = {
  previewOpenOnUserDevice: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};

export const ServerPatch = {
  previewOpenOnUserDevice: Schema.optionalKey(Schema.Boolean),
};

export const Client = {
  browserAllowRemoteDeviceTabs: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  browserAllowRemoteDeviceControl: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
};

export const ClientPatch = {
  browserAllowRemoteDeviceTabs: Schema.optionalKey(Schema.Boolean),
  browserAllowRemoteDeviceControl: Schema.optionalKey(Schema.Boolean),
};
