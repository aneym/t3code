import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const DefaultTrue = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));

export const ForkThreadSettingsFields = {
  retainAutomationPlacement: DefaultTrue,
  queuedMessagesAnswerPendingInput: DefaultTrue,
  batchQueuedMessages: DefaultTrue,
  queueSendAll: DefaultTrue,
  settleIdleChildren: DefaultTrue,
};

export const ForkThreadSettingsPatchFields = {
  retainAutomationPlacement: Schema.optionalKey(Schema.Boolean),
  queuedMessagesAnswerPendingInput: Schema.optionalKey(Schema.Boolean),
  batchQueuedMessages: Schema.optionalKey(Schema.Boolean),
  queueSendAll: Schema.optionalKey(Schema.Boolean),
  settleIdleChildren: Schema.optionalKey(Schema.Boolean),
};
