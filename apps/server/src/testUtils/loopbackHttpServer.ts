// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer builds from a Node server factory.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeHttp from "node:http";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpServer } from "effect/http";

export const layerLoopbackServer = NodeHttpServer.layer(NodeHttp.createServer, {
  port: 0,
  host: "127.0.0.1",
});

export const layerLoopbackTest = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
    ),
  ),
  Layer.provideMerge(layerLoopbackServer),
);
