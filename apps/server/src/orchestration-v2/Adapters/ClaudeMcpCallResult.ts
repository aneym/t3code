import type { ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

export function claudeMcpCallToolResult(
  value: unknown,
): ProviderAdapter.ProviderAdapterV2McpCallToolResult {
  const record = Predicate.isObject(value) && !Array.isArray(value) ? value : undefined;
  const content = record === undefined ? value : record.content;
  return {
    content:
      typeof content === "string"
        ? [{ type: "text", text: content }]
        : Array.isArray(content)
          ? content
          : [],
    ...(record?.structuredContent === undefined
      ? {}
      : { structuredContent: record.structuredContent }),
    ...(record?.isError === true ? { isError: true } : {}),
    ...(record?._meta === undefined ? {} : { _meta: record._meta }),
  };
}

const toolErrorText = (error: unknown) =>
  error instanceof Error &&
  Reflect.get(error, "errorClass") === "control_request_failed" &&
  error.message.trim() !== ""
    ? error.message.slice(0, 2000)
    : undefined;

export const claudeMcpCallResult = <E extends { readonly cause: unknown }, R>(
  driver: ProviderDriverKind,
  call: Effect.Effect<unknown, E, R>,
) =>
  call.pipe(
    Effect.map(claudeMcpCallToolResult),
    Effect.catch((cause) => {
      const text = toolErrorText(cause.cause);
      return text === undefined
        ? Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver,
              detail: "Claude MCP tool call failed.",
              cause,
            }),
          )
        : Effect.succeed<ProviderAdapter.ProviderAdapterV2McpCallToolResult>({
            content: [{ type: "text", text }],
            isError: true,
          });
    }),
  );
