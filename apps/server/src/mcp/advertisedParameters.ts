import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

const acceptsType = (schema: unknown, value: unknown): boolean => {
  if (!Predicate.isObject(schema) || typeof schema.type !== "string") return true;
  switch (schema.type) {
    case "object":
      return Predicate.isObject(value) && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    case "integer":
    case "number":
      return typeof value === "number";
    default:
      return typeof value === schema.type;
  }
};

const unknownParameter = (schema: unknown, value: unknown, path = ""): string | undefined => {
  if (!Predicate.isObject(schema)) return undefined;
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter((branch) => acceptsType(branch, value));
    const unknowns = branches.map((branch) => unknownParameter(branch, value, path));
    if (unknowns.length > 0 && unknowns.every((key) => key !== undefined)) return unknowns[0];
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const items =
        Array.isArray(schema.prefixItems) && index < schema.prefixItems.length
          ? schema.prefixItems[index]
          : Array.isArray(schema.items)
            ? schema.items[index]
            : schema.items;
      const key = unknownParameter(items, item, `${path}[${index}]`);
      if (key !== undefined) return key;
    }
  } else if (Predicate.isObject(value)) {
    const properties = Predicate.isObject(schema.properties) ? schema.properties : undefined;
    for (const [name, item] of Object.entries(value)) {
      const key = path === "" ? name : `${path}.${name}`;
      const known = properties !== undefined && Object.hasOwn(properties, name);
      if (
        properties !== undefined &&
        !known &&
        schema.additionalProperties !== true &&
        !Predicate.isObject(schema.additionalProperties)
      )
        return key;
      const nested = unknownParameter(
        known ? properties[name] : schema.additionalProperties,
        item,
        key,
      );
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

export const validateAdvertisedParameters = Effect.fn("McpToolParameters.validate")(function* (
  name: string,
  schema: unknown,
  payload: unknown,
) {
  const key = unknownParameter(schema, payload);
  if (key !== undefined) {
    return yield* new McpSchema.InvalidParams({
      message: `${name}: unknown parameter "${key}"`,
    });
  }
});

export const decodeAsAdvertised = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) =>
      tool.setParameters(Schema.toCodecJson(tool.parametersSchema)),
    ),
  ) as unknown as Toolkit.Toolkit<Tools>;
