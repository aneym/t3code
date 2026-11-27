import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";

export interface PoolHeadroom {
  readonly exhausted: boolean;
  readonly resetsAt?: string | undefined;
}

const AGENT_LB_POOL: Record<string, string> = {
  codex: "openai",
  claudeAgent: "anthropic",
  gemini: "gemini",
};

const agentLbUrl = () => process.env.T3_AGENT_LB_URL?.trim() || "http://127.0.0.1:2456";

const resetIso = (value: unknown): string | undefined =>
  typeof value === "number"
    ? DateTime.formatIso(DateTime.makeUnsafe(value * 1_000))
    : typeof value === "string" && value.length > 0
      ? value
      : undefined;

function readPool(value: unknown): PoolHeadroom | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const pool = value as Record<string, unknown>;
  const exhausted =
    pool.exhausted === true ||
    pool.available === 0 ||
    pool.availableAccounts === 0 ||
    pool.usable === 0 ||
    pool.headroomPercent === 0;
  return { exhausted, resetsAt: resetIso(pool.resetsAt ?? pool.resets_at) };
}

function readHeadroom(body: unknown): ReadonlyMap<string, PoolHeadroom> {
  const pools = new Map<string, PoolHeadroom>();
  if (body === null || typeof body !== "object") return pools;
  const list = (body as { pools?: unknown }).pools ?? body;
  const entries = Array.isArray(list)
    ? list.map((pool) => [(pool as { provider?: unknown })?.provider, pool] as const)
    : Object.entries(list as Record<string, unknown>);
  for (const [provider, pool] of entries) {
    const read = typeof provider === "string" ? readPool(pool) : undefined;
    if (read !== undefined) pools.set(provider as string, read);
  }
  return pools;
}

const noHeadroom: ReadonlyMap<string, PoolHeadroom> = new Map();

export const probePoolHeadroom: Effect.Effect<(instanceId: string) => PoolHeadroom | undefined> =
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(`${agentLbUrl()}/api/pools/headroom`);
    return response.status === 200 ? readHeadroom(yield* response.json) : noHeadroom;
  }).pipe(
    Effect.timeout(Duration.millis(1_500)),
    Effect.provide(FetchHttpClient.layer),
    Effect.orElseSucceed(() => noHeadroom),
    Effect.map(
      (pools) => (instanceId: string) => pools.get(AGENT_LB_POOL[instanceId] ?? instanceId),
    ),
  );
