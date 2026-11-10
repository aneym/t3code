import * as Layer from "effect/Layer";
import { McpProtocol, McpServer } from "effect/ai";

import packageJson from "../../../package.json" with { type: "json" };
import { layerMcpAuthMiddleware } from "../McpAuthMiddleware.ts";

export const layerMcpTransport = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
  allowSessionTermination: true,
}).pipe(Layer.provide(layerMcpAuthMiddleware));
