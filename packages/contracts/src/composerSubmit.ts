import * as Schema from "effect/Schema";

import { MessageId } from "./baseSchemas.ts";

export const OrchestrationV2ComposerSubmit = Schema.Struct({
  displayedAssistantMessageId: Schema.NullOr(MessageId),
});
export type OrchestrationV2ComposerSubmit = typeof OrchestrationV2ComposerSubmit.Type;

export const composerSubmitOf = (source: {
  readonly composerSubmit?: OrchestrationV2ComposerSubmit | undefined;
}) => (source.composerSubmit === undefined ? {} : { composerSubmit: source.composerSubmit });

export const withoutComposerSubmit = <T extends { readonly composerSubmit?: unknown }>({
  composerSubmit: _composerSubmit,
  ...rest
}: T): Omit<T, "composerSubmit"> => rest;
