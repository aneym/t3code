import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const DefaultTrue = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));
const DefaultFalse = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)));

export const DelegatedChildModel = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});
export type DelegatedChildModel = typeof DelegatedChildModel.Type;

export const ForkThreadSettingsFields = {
  retainAutomationPlacement: DefaultTrue,
  batchQueuedMessages: DefaultTrue,
  queuedMessagesAnswerPendingInput: DefaultTrue,
  quietThreadNotes: DefaultTrue,
  childCompletionNotes: DefaultTrue,
  headlessSubagentStreaming: DefaultTrue,
  mcpEventsEnabled: DefaultFalse,
  mcpClientApprovals: DefaultTrue,
  mcpEventsCallbackBaseUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  peerLinkRenewalEnabled: DefaultFalse,
  delegatedChildModel: Schema.NullOr(DelegatedChildModel).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  childStart: Schema.Unknown.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
};

export const ForkThreadSettingsPatchFields = {
  retainAutomationPlacement: Schema.optionalKey(Schema.Boolean),
  batchQueuedMessages: Schema.optionalKey(Schema.Boolean),
  queuedMessagesAnswerPendingInput: Schema.optionalKey(Schema.Boolean),
  quietThreadNotes: Schema.optionalKey(Schema.Boolean),
  childCompletionNotes: Schema.optionalKey(Schema.Boolean),
  headlessSubagentStreaming: Schema.optionalKey(Schema.Boolean),
  mcpEventsEnabled: Schema.optionalKey(Schema.Boolean),
  mcpClientApprovals: Schema.optionalKey(Schema.Boolean),
  mcpEventsCallbackBaseUrl: Schema.optionalKey(Schema.String),
  peerLinkRenewalEnabled: Schema.optionalKey(Schema.Boolean),
  delegatedChildModel: Schema.optionalKey(Schema.NullOr(DelegatedChildModel)),
  childStart: Schema.optionalKey(Schema.Unknown),
};
