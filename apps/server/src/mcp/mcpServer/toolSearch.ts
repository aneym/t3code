import { MCP_TOOL_EXPOSURE_HEADER } from "@t3tools/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpServer } from "effect/ai";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolExposure from "../McpToolExposure.ts";
import * as ToolSearchHandlers from "../toolkits/toolSearch/handlers.ts";
import { ToolSearchToolkit } from "../toolkits/toolSearch/tools.ts";
import { toolkitRegistration } from "./toolkitRegistration.ts";

const layerToolExposure = Layer.effect(
  McpToolExposure.McpToolExposure,
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return McpToolExposure.make(
      () =>
        server.tools.map(({ tool }) => ({ name: tool.name, description: tool.description ?? "" })),
      () => server.notifications["notifications/tools/list_changed"]({}),
    );
  }),
);

/**
 * A provider session that sends `MCP_TOOL_EXPOSURE_HEADER: deferred` lists only
 * the direct tools and what its `tool_search` calls loaded. Calls are never
 * gated, and every other client lists everything but `tool_search`.
 */
const layerDeferredListing = McpServer.visibility(
  Effect.gen(function* () {
    const exposure = yield* McpToolExposure.McpToolExposure;
    // Untraced: it runs once per tool on every list request.
    return Effect.fnUntraced(function* ({ method, target, headers }: McpServer.MiddlewareOptions) {
      if (method !== "tools/list") return true;
      const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
      const providerSessionId = Option.getOrUndefined(scope)?.thread?.providerSessionId;
      if (headers[MCP_TOOL_EXPOSURE_HEADER] !== "deferred" || providerSessionId === undefined) {
        return target !== McpToolExposure.TOOL_SEARCH;
      }
      return exposure.isListed(providerSessionId, target);
    });
  }),
  { global: true },
);

/** Outside layerTools: the clients its budget measures never list `tool_search`. */
export const layerToolSearch = Layer.mergeAll(
  toolkitRegistration(ToolSearchToolkit, ToolSearchHandlers.layer),
  layerDeferredListing,
).pipe(Layer.provide(layerToolExposure));
