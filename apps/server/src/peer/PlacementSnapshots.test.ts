import { EnvironmentId, OrchestratorMcpFailure, ProjectId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Peers from "./PeerMcpClient.ts";
import * as PlacementSnapshots from "./PlacementSnapshots.ts";

const PEER_ID = EnvironmentId.make("env:peer-legacy");
const LIMITS: Peers.PeerCallLimits = {
  runtimeMode: "full-access",
  interactionMode: "default",
};

describe("PlacementSnapshots", () => {
  it.effect(
    "falls back to t3_project_list for agent-home keys when an older peer returns placementProjectCount 0",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const peers: Peers.PeerMcpClient["Service"] = {
          call: ((input: {
            readonly tool: string;
            readonly arguments: Record<string, unknown>;
          }) => {
            calls.push(input.tool);
            if (input.tool === "t3_environment_read") {
              return Effect.succeed({
                label: "Heron (ax42)",
                placementProjectCount: 0,
              });
            }
            if (input.tool === "t3_project_list") {
              return Effect.succeed({
                projects: [
                  {
                    id: ProjectId.make("mcp:bot-home"),
                    workspaceRoot: "/home/jobs/.agent-rails/agents/bot",
                    repositoryIdentity: null,
                    archivedAt: null,
                  },
                  {
                    id: ProjectId.make("mcp:bot-exec"),
                    workspaceRoot: "/home/jobs/.agent-rails/agents/bot/executor",
                    repositoryIdentity: null,
                    archivedAt: null,
                  },
                ],
                nextCursor: null,
              });
            }
            return Effect.fail(
              new OrchestratorMcpFailure({ code: "invalid_request", message: "unexpected tool" }),
            );
          }) as Peers.PeerMcpClient["Service"]["call"],
        };
        const keys = [
          "agent-home-handle:bot/executor",
          "agent-home:/home/jobs/.agent-rails/agents/bot/executor",
        ];
        const store = yield* PlacementSnapshots.make(peers);
        yield* store.refresh({
          environmentIds: [PEER_ID],
          keys,
          limits: LIMITS,
          now: 1_000,
        });
        const cached = store.cached(PEER_ID, keys, 1_000);
        assert.isDefined(cached?.value);
        assert.equal(cached?.value?.placementProjectCount, 1);
        assert.equal(cached?.value?.placementProjectId, ProjectId.make("mcp:bot-exec"));
        assert.deepEqual(calls, ["t3_environment_read", "t3_project_list"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "prefers active shell executor paths and skips t3_project_list when peer resolves or keys are non-agent-home",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const peers: Peers.PeerMcpClient["Service"] = {
          call: ((input: {
            readonly tool: string;
            readonly arguments: Record<string, unknown>;
          }) => {
            calls.push(input.tool);
            if (input.tool === "t3_environment_read") {
              const key = String(input.arguments.placementRepositoryKey ?? "");
              if (key.includes("already-matched")) {
                return Effect.succeed({
                  label: "new-peer",
                  placementProjectCount: 1,
                  placementProjectId: ProjectId.make("mcp:direct"),
                });
              }
              return Effect.succeed({
                label: "peer",
                placementProjectCount: 0,
              });
            }
            if (input.tool === "t3_project_list") {
              return Effect.succeed({
                projects: [
                  {
                    id: ProjectId.make("mcp:factory-agents"),
                    workspaceRoot: "/home/jobs/.agent-rails/agents/factory/executor",
                    repositoryIdentity: null,
                    archivedAt: null,
                  },
                  {
                    id: ProjectId.make("mcp:factory-shells"),
                    workspaceRoot: "/home/jobs/.agent-rails/shells/factory/executor",
                    repositoryIdentity: null,
                    archivedAt: null,
                  },
                ],
                nextCursor: null,
              });
            }
            return Effect.fail(
              new OrchestratorMcpFailure({ code: "invalid_request", message: "unexpected tool" }),
            );
          }) as Peers.PeerMcpClient["Service"]["call"],
        };
        const store = yield* PlacementSnapshots.make(peers);

        const factoryKeys = ["agent-home-handle:factory/executor"];
        yield* store.refresh({
          environmentIds: [PEER_ID],
          keys: factoryKeys,
          limits: LIMITS,
          now: 1_000,
        });
        assert.equal(
          store.cached(PEER_ID, factoryKeys, 1_000)?.value?.placementProjectId,
          ProjectId.make("mcp:factory-shells"),
        );

        calls.length = 0;
        const directKeys = ["agent-home-handle:already-matched/executor"];
        yield* store.refresh({
          environmentIds: [PEER_ID],
          keys: directKeys,
          limits: LIMITS,
          now: 1_000,
        });
        assert.equal(
          store.cached(PEER_ID, directKeys, 1_000)?.value?.placementProjectId,
          ProjectId.make("mcp:direct"),
        );
        assert.deepEqual(calls, ["t3_environment_read"]);

        calls.length = 0;
        const repoKeys = ["github.com/shelf-group/open-factory"];
        yield* store.refresh({
          environmentIds: [PEER_ID],
          keys: repoKeys,
          limits: LIMITS,
          now: 1_000,
        });
        assert.isUndefined(store.cached(PEER_ID, repoKeys, 1_000)?.value?.placementProjectId);
        assert.deepEqual(calls, ["t3_environment_read"]);
      }).pipe(Effect.scoped),
  );
});
