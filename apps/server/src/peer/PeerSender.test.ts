import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Tool, Toolkit } from "effect/ai";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as Schema from "effect/Schema";
import { PeerLinks } from "./PeerLinks.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { PeerMcpClient, layer as peerMcpLayer } from "./PeerMcpClient.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const Sender = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  environmentId: Schema.optional(EnvironmentId),
  environmentLabel: Schema.optional(Schema.String),
});

it.effect(
  "binds forwarded senders to the authenticated peer while delivering mismatched claims",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const source = descriptorOf("sender-environment", "\u0000Sender\n" + "x".repeat(100));
        const receiver = descriptorOf("receiver-environment", "Receiver");
        const toolkit = Toolkit.make(
          Tool.make("sender", {
            description: "Reads the authenticated sender.",
            success: Sender,
            failure: OrchestratorMcpFailure,
            failureMode: "return",
            dependencies: [McpInvocationContext],
          }),
        );
        const peer = yield* servePeer(
          receiver,
          McpHttpServer.toolkitRegistration(
            toolkit,
            McpToolAccess.toLayer(toolkit, {
              sender: McpToolAccess.reads(() =>
                McpInvocationContext.pipe(Effect.map((scope) => scope.client?.sender ?? {})),
              ),
            }),
          ),
        );
        const context = yield* layerLinkingEnvironment(source).pipe(Layer.build);
        yield* linkTo(Context.get(context, PeerLinks), peer);
        const client = Context.get(context, PeerMcpClient);
        const links = Context.get(context, PeerLinks);
        const resolved = yield* links.resolve(receiver.environmentId);
        const oldSession = yield* peer.auth.issueMcpClientSession({
          label: "Old peer",
          peerLink: true,
          access: "auto",
          client: { deviceType: "bot" },
        });
        const legacy = yield* peerMcpLayer.pipe(
          Layer.provide(
            Layer.mock(PeerLinks)({
              resolve: () => Effect.succeed({ ...resolved, token: oldSession.token }),
              recordOutcome: () => Effect.void,
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
          Layer.build,
          Effect.map((context) => Context.get(context, PeerMcpClient)),
        );
        for (const environmentId of [
          source.environmentId,
          receiver.environmentId,
          EnvironmentId.make("third-environment"),
          undefined,
        ]) {
          const result = yield* (environmentId === undefined ? legacy : client).call({
            environmentId: receiver.environmentId,
            tool: "sender",
            arguments: {},
            limits: { runtimeMode: "auto", interactionMode: "default" },
            sender: {
              threadId: ThreadId.make("same-thread-id"),
              environmentId: environmentId ?? source.environmentId,
            },
            success: Sender,
          });
          expect(result).toMatchObject(
            environmentId === source.environmentId
              ? {
                  threadId: "same-thread-id",
                  environmentId: source.environmentId,
                  environmentLabel: "Sender" + "x".repeat(74),
                }
              : {},
          );
          if (environmentId !== source.environmentId) expect(result).toEqual({});
        }
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
