import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const DefaultTrue = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));
const DefaultFalse = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)));

export const DelegatedChildModel = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type DelegatedChildModel = typeof DelegatedChildModel.Type;

export const ForkThreadSettingsFields = {
  retainAutomationPlacement: DefaultTrue,
  queuedMessagesAnswerPendingInput: DefaultTrue,
  batchQueuedMessages: DefaultTrue,
  queueSendAll: DefaultTrue,
  settleIdleChildren: DefaultTrue,
  quietThreadNotes: DefaultTrue,
  childCompletionNotes: DefaultTrue,
  headlessSubagentStreaming: DefaultTrue,
  mcpEventsEnabled: DefaultFalse,
  mcpEventsCallbackBaseUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  hostLinkEnabled: DefaultFalse,
  hostLinkUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  delegatedChildModel: Schema.NullOr(DelegatedChildModel).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
};

export const ForkThreadSettingsPatchFields = {
  retainAutomationPlacement: Schema.optionalKey(Schema.Boolean),
  queuedMessagesAnswerPendingInput: Schema.optionalKey(Schema.Boolean),
  batchQueuedMessages: Schema.optionalKey(Schema.Boolean),
  queueSendAll: Schema.optionalKey(Schema.Boolean),
  settleIdleChildren: Schema.optionalKey(Schema.Boolean),
  quietThreadNotes: Schema.optionalKey(Schema.Boolean),
  childCompletionNotes: Schema.optionalKey(Schema.Boolean),
  headlessSubagentStreaming: Schema.optionalKey(Schema.Boolean),
  mcpEventsEnabled: Schema.optionalKey(Schema.Boolean),
  mcpEventsCallbackBaseUrl: Schema.optionalKey(Schema.String),
  hostLinkEnabled: Schema.optionalKey(Schema.Boolean),
  hostLinkUrl: Schema.optionalKey(Schema.String),
  delegatedChildModel: Schema.optionalKey(Schema.NullOr(DelegatedChildModel)),
};
