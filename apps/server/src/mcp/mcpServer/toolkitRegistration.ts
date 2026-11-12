import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import { acceptedJsonSchema, advertisedJsonSchema } from "../advertisedJsonSchema.ts";
import { decodeAsAdvertised, validateAdvertisedParameters } from "../advertisedParameters.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import { noteTool } from "../../observability/RequestLog.ts";
import { withToolAnalytics } from "./toolAnalytics.ts";

const withAdvertisedParameters = Effect.fn("McpHttpServer.withAdvertisedSchemas")(function* <
  A,
  E,
  R,
>(
  registration: Effect.Effect<A, E, R>,
  toolkit?: { readonly tools: Readonly<Record<string, Tool.Any>> },
) {
  const server = yield* McpServer.McpServer;
  const advertisingServer = McpServer.McpServer.of({
    ...server,
    addTool: Effect.fn("McpServer.addTool")(function (options) {
      const original = toolkit?.tools[options.tool.name];
      const tool =
        original === undefined
          ? options.tool
          : new McpSchema.Tool({ ...options.tool, inputSchema: advertisedJsonSchema(original) });
      return server.addTool({
        ...options,
        tool,
        annotations: McpInvocationContext.gateByToolProfile(tool.name, options.annotations),
        handle: (payload) =>
          Effect.andThen(
            noteTool(tool.name),
            validateAdvertisedParameters(
              tool.name,
              original === undefined ? tool.inputSchema : acceptedJsonSchema(original),
              payload,
            ),
          ).pipe(Effect.andThen(() => options.handle(payload))),
      });
    }),
  });
  return yield* registration.pipe(Effect.provideService(McpServer.McpServer, advertisingServer));
});

/**
 * `McpServer.toolkit` asks for every service its tools declare when it
 * registers them, but the auth middleware provides `McpInvocationContext` to
 * each request instead. Registration must not get one: the services it
 * captures would replace the request's.
 */
export const toolkitRegistration = <Tools extends Record<string, Tool.Any>, EX, RX>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) => {
  const registration = Layer.effectDiscard(
    withToolAnalytics(
      withAdvertisedParameters(McpServer.registerToolkit(decodeAsAdvertised(toolkit)), toolkit),
    ),
  ).pipe(Layer.provide(McpServer.McpServer.layer));
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off - the auth middleware provides it per request.
  const registered = registration as Layer.Layer<
    never,
    never,
    Exclude<Layer.Services<typeof registration>, McpInvocationContext.McpInvocationContext>
  >;
  return registered.pipe(Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)));
};

export const imageToolRegistration = <Tools extends Record<string, Tool.Any>, A, E, R, EX, RX>(
  register: Effect.Effect<A, E, R>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) =>
  Layer.effectDiscard(withToolAnalytics(withAdvertisedParameters(register))).pipe(
    Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)),
  );
