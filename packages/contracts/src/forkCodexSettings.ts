import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

export const CodexFields = {
  baseUrl: TrimmedString.check(Schema.isPattern(/^(?:https?:\/\/[^\s"'\\]+)?$/u)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Base URL",
      description:
        "OpenAI-compatible URL that gets Codex requests and the token. Empty uses OpenAI.",
      providerSettingsForm: {
        placeholder: "https://api.openai.com/v1",
        clearWhenEmpty: "omit",
      },
    }),
  ),
};
