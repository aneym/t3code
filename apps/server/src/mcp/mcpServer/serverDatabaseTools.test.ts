import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerDatabase from "../../serverDatabase/ServerDatabase.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { McpClientAuthenticator } from "../McpAuthMiddleware.ts";
import type * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpSessionRegistry from "../McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";
import { layerServerDatabaseTools } from "./serverDatabaseTools.ts";
import { layerToolSearch } from "./toolSearch.ts";
import { layerMcpTransport } from "./transport.ts";

const environmentId = EnvironmentId.make("environment-db-tools-test");
const base = { environmentId, capabilities: new Set(["orchestration"] as const), issuedAt: 1 };
const scopes = new Map<string, McpInvocationContext.McpInvocationScope>([
  [
    "agentToken",
    {
      ...base,
      requestNamespace: "agentToken",
      thread: {
        threadId: ThreadId.make("thread-agent"),
        providerSessionId: "agentToken",
        providerInstanceId: ProviderInstanceId.make("copilot"),
      },
      client: undefined,
    },
  ],
  [
    "clientToken",
    {
      ...base,
      requestNamespace: "clientToken",
      thread: undefined,
      client: { sessionId: "client", label: "client", access: "full-access" },
    },
  ],
  [
    "ownerToken",
    {
      ...base,
      requestNamespace: "ownerToken",
      thread: undefined,
      client: { sessionId: "owner", label: "t3 owner cli", access: "full-access", ownerCli: true },
    },
  ],
]);

it.effect("shows and runs the server database tools for the owner CLI alone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = layerMcpTransport(
        Layer.mergeAll(layerServerDatabaseTools, layerToolSearch),
      ).pipe(
        Layer.provide(
          Layer.mock(ServerDatabase.ServerDatabase)({
            listRuns: () => Effect.succeed({ runs: [] }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) =>
              Effect.succeed(
                token === "agentToken"
                  ? (scopes.get(token) as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                scopes.get((request.headers.authorization ?? "").replace(/^Bearer /u, "")),
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const session = Effect.fn(function* (token: string) {
        const headers = {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "t3-tool-exposure": "deferred",
        };
        const initialize = yield* httpClient.post("/mcp", {
          headers,
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
            "application/json",
          ),
        });
        const rpc = (method: string, params: object) =>
          httpClient
            .post("/mcp", {
              headers: {
                ...headers,
                "mcp-session-id": initialize.headers["mcp-session-id"]!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(
                JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
                "application/json",
              ),
            })
            .pipe(
              Effect.flatMap((response) => response.text),
              Effect.map((text) =>
                text
                  .split("\n")
                  .filter((line) => line.startsWith("data: ") || line.startsWith("{"))
                  .map(
                    (line) =>
                      JSON.parse(line.replace(/^data: /u, "")) as {
                        id?: number;
                        result?: {
                          tools?: ReadonlyArray<{ name: string }>;
                          structuredContent?: unknown;
                        };
                        error?: unknown;
                      },
                  )
                  .find((message) => message.id === 2)!,
              ),
            );
        return {
          listed: rpc("tools/list", {}).pipe(
            Effect.map((body) => (body.result?.tools ?? []).map((tool) => tool.name).toSorted()),
          ),
          runs: rpc("tools/call", { name: "t3_runs_list", arguments: { open: true } }),
          search: rpc("tools/call", {
            name: "tool_search",
            arguments: { query: "runs db snapshot" },
          }),
        };
      });

      const owner = yield* session("ownerToken");
      expect(yield* owner.listed).toEqual(["t3_db_info", "t3_db_snapshot", "t3_runs_list"]);
      expect((yield* owner.runs).result?.structuredContent).toEqual({ runs: [] });

      for (const token of ["agentToken", "clientToken"]) {
        const other = yield* session(token);
        expect(yield* other.listed).not.toContain("t3_runs_list");
        const refused = yield* other.runs;
        expect(refused.result?.structuredContent).toBeUndefined();
      }
      const agent = yield* session("agentToken");
      expect((yield* agent.search).result?.structuredContent).toEqual({ tools: [] });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
