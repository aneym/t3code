import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpServer } from "effect/ai";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as ServerAuthHandlers from "../toolkits/serverAuth/handlers.ts";
import { ServerAuthToolkit } from "../toolkits/serverAuth/tools.ts";
import * as ServerDatabaseHandlers from "../toolkits/serverDatabase/handlers.ts";
import { ServerDatabaseToolkit } from "../toolkits/serverDatabase/tools.ts";
import { toolkitRegistration } from "./toolkitRegistration.ts";

export const OWNER_CLI_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(ServerDatabaseToolkit.tools),
  ...Object.keys(ServerAuthToolkit.tools),
]);

const ownerCliOnly = McpServer.visibility(() =>
  Effect.map(
    Effect.serviceOption(McpInvocationContext.McpInvocationContext),
    (scope) => Option.getOrUndefined(scope)?.client?.ownerCli === true,
  ),
);

export const layerOwnerCliTools = Layer.mergeAll(
  toolkitRegistration(ServerDatabaseToolkit, ServerDatabaseHandlers.layer),
  toolkitRegistration(ServerAuthToolkit, ServerAuthHandlers.layer),
).pipe(Layer.provide(ownerCliOnly.layer));
