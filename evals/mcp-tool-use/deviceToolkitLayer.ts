import * as Layer from "effect/Layer";

import { layerDeviceToolkit } from "../../apps/server/src/mcp/McpHttpServer.ts";
import { layerInProcessMcpServer } from "../../apps/server/src/mcp/mcpServer/transport.ts";

export const inProcessDeviceToolkit = layerDeviceToolkit.pipe(
  Layer.provideMerge(layerInProcessMcpServer),
);
