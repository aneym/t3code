import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { AiError, Tool, Toolkit } from "effect/ai";

import { acceptedJsonSchema, advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import { cutText } from "./mcpServer/cutText.ts";

const MAX_NAMED_ARGUMENTS = 5;
const MAX_ARGUMENT_NAME_CHARS = 64;

const propertyNames = (schema: { readonly properties?: unknown }) =>
  Predicate.isObject(schema.properties) ? Object.keys(schema.properties) : [];

/**
 * Rejects top-level arguments the advertised schema does not list, naming them. Nested objects stay lenient:
 * the advertised schema merges tagged unions, so strict decoding would reject keys agents were shown.
 */
const advertisedArgumentsOnly = (tool: Tool.Any) => {
  const accepted = new Set(propertyNames(acceptedJsonSchema(tool)));
  const acceptedText = propertyNames(advertisedJsonSchema(tool)).join(", ") || "none";
  return Schema.Record(Schema.String, Schema.Unknown).check(
    Schema.makeFilter((input) => {
      const unknown = Object.keys(input).filter((key) => !accepted.has(key));
      if (unknown.length === 0) return undefined;
      const named = unknown
        .slice(0, MAX_NAMED_ARGUMENTS)
        .map((key) => JSON.stringify(cutText(key, MAX_ARGUMENT_NAME_CHARS)));
      const more =
        unknown.length > named.length ? ` and ${unknown.length - named.length} more` : "";
      return `Unknown argument${unknown.length === 1 ? "" : "s"} ${named.join(", ")}${more}. Accepted arguments: ${acceptedText}.`;
    }),
  );
};

/** Decode with the advertised JSON codec, which permits null for optional fields that the raw schema rejects. */
export const decodeAsAdvertised = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) =>
      tool.setParameters(
        advertisedArgumentsOnly(tool).pipe(
          Schema.decodeTo(Schema.toCodecJson(tool.parametersSchema)),
        ),
      ),
    ),
  ) as unknown as Toolkit.Toolkit<Tools>;

export const parameterValidationMessage = (error: unknown) =>
  AiError.isAiError(error) && error.reason._tag === "ToolParameterValidationError"
    ? error.reason.message
    : undefined;
