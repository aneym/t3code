import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import { advertisedJsonSchema } from "../advertisedJsonSchema.ts";
import { decodeAsAdvertised } from "../advertisedParameters.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import { withToolAnalytics } from "./toolAnalytics.ts";

/** `McpServer.registerToolkit` advertises the full codec schema; agents get the compact one. */
const withAdvertisedSchemas = Effect.fn("McpHttpServer.withAdvertisedSchemas")(function* <
  Tools extends Record<string, Tool.Any>,
  A,
  E,
  R,
>(toolkit: Toolkit.Toolkit<Tools>, registration: Effect.Effect<A, E, R>) {
  const server = yield* McpServer.McpServer;
  const tools: Record<string, Tool.Any> = toolkit.tools;
  const advertisingServer = McpServer.McpServer.of({
    ...server,
    addTool: Effect.fn("McpServer.addTool")(function (options) {
      const tool = tools[options.tool.name];
      return server.addTool(
        tool === undefined
          ? options
          : {
              ...options,
              tool: new McpSchema.Tool({
                ...options.tool,
                inputSchema: advertisedJsonSchema(tool),
              }),
            },
      );
    }),
  });
  return yield* registration.pipe(Effect.provideService(McpServer.McpServer, advertisingServer));
});

/** Each tool call gets a span named for its tool; arguments stay out, as they carry prompts and IDs. */
const withToolSpans = Effect.fn("McpHttpServer.withToolSpans")(function* <A, E, R>(
  registration: Effect.Effect<A, E, R>,
) {
  const server = yield* McpServer.McpServer;
  const tracingServer = McpServer.McpServer.of({
    ...server,
    addTool: Effect.fn("McpServer.addTool")(function (options) {
      const name = options.tool.name;
      return server.addTool({
        ...options,
        // Never the current span: Toolkit.handle annotates that one with the raw arguments.
        handle: (payload) =>
          Effect.useSpan(
            `mcp.tool.${name}`,
            {
              attributes: {
                "rpc.system": "mcp",
                "rpc.method": "tools/call",
                "mcp.tool.name": name,
              },
            },
            () => options.handle(payload),
          ),
      });
    }),
  });
  return yield* registration.pipe(Effect.provideService(McpServer.McpServer, tracingServer));
});

/** Hands each call the services its registration was built with; the request's own still win. */
const provideRegistrationServices = <Services>() =>
  McpServer.middleware<{ provides: Services }>()(
    Effect.map(
      Effect.context<Services>(),
      (services) => (effect) =>
        Effect.updateContext(effect, (request: Context.Context<never>) =>
          Context.merge(services, request),
        ),
    ),
  );

/**
 * Tools declare their handler services as request-level dependencies. Those
 * built with the server are provided here; `McpInvocationContext` is left to
 * the transport, whose auth middleware resolves it per request.
 */
export const toolkitRegistration = <Tools extends Record<string, Tool.Any>, EX, RX>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) =>
  Layer.effectDiscard(
    withToolAnalytics(
      withToolSpans(
        withAdvertisedSchemas(toolkit, McpServer.registerToolkit(decodeAsAdvertised(toolkit))),
      ),
    ),
  ).pipe(
    Layer.provide(
      provideRegistrationServices<
        Exclude<Tool.Requirements<Tools[keyof Tools]>, McpInvocationContext.McpInvocationContext>
      >().layer,
    ),
    Layer.provide(McpServer.McpServer.layer),
    Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)),
  );

export const imageToolRegistration = <Tools extends Record<string, Tool.Any>, A, E, R, EX, RX>(
  register: Effect.Effect<A, E, R>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) =>
  Layer.effectDiscard(withToolAnalytics(withToolSpans(register))).pipe(
    Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)),
  );
