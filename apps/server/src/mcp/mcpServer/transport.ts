import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpProtocol, McpServer } from "effect/ai";

import packageJson from "../../../package.json" with { type: "json" };
import { layerMcpAuthMiddleware } from "../McpAuthMiddleware.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";

export const layerMcpTransport = <RA, RE, RR>(registrations: Layer.Layer<RA, RE, RR>) =>
  McpServer.layerHttp({
    name: "T3 Code",
    version: packageJson.version,
    path: "/mcp",
    // The first protocol is the fallback for clients that offer an unknown version.
    protocols: [McpProtocol.v2025_06_18, McpProtocol.v2026_07_28],
    allowSessionTermination: true,
    registrations,
  }).pipe(Layer.provide(layerMcpAuthMiddleware));

/**
 * `McpServer` for in-process calls, which provide `McpInvocationContext`
 * around `callTool` as the auth middleware does for each /mcp request.
 */
export const layerInProcessMcpServer = McpServer.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(
  (effect) =>
    Effect.flatMap(
      Effect.serviceOption(McpInvocationContext.McpInvocationContext),
      Option.match({
        onNone: () => Effect.die("Provide McpInvocationContext around the in-process MCP call."),
        onSome: (scope) =>
          Effect.provideService(effect, McpInvocationContext.McpInvocationContext, scope),
      }),
    ),
  { global: true },
).pipe(Layer.provideMerge(McpServer.McpServer.layer));
