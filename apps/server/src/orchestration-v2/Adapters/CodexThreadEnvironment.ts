import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import * as PortScanner from "../../preview/PortScanner.ts";
import { railsAgentIdOfCwd, withT3ThreadEnvironment } from "./T3ThreadEnvironment.ts";

const CONFIG_KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stdioServerNames = (servers: unknown): ReadonlyArray<string> =>
  isRecord(servers)
    ? Object.entries(servers).flatMap(([name, server]) =>
        CONFIG_KEY_SEGMENT.test(name) && isRecord(server) && typeof server.command === "string"
          ? [name]
          : [],
      )
    : [];

const codexThreadEnvironmentConfig = (
  variables: NodeJS.ProcessEnv,
  mcpServers: unknown,
): Record<string, Schema.Json> => {
  const servers = stdioServerNames(mcpServers);
  return Object.fromEntries(
    Object.entries(variables).flatMap(([name, value]) =>
      value === undefined || !CONFIG_KEY_SEGMENT.test(name)
        ? []
        : [
            [`shell_environment_policy.set.${name}`, value],
            ...servers.map((server) => [`mcp_servers.${server}.env.${name}`, value]),
          ],
    ),
  );
};

export const codexThreadEnvironment = Effect.fn("CodexThreadEnvironment.resolve")(
  function* (input: {
    readonly threadId: string | null;
    readonly cwd: string | null | undefined;
    readonly environmentId: string | undefined;
    readonly readConfig: (cwd: string | null | undefined) => Effect.Effect<unknown, object>;
  }) {
    if (input.threadId === null) return {};
    const variables = {
      [PortScanner.AGENT_THREAD_ENV]: input.threadId,
      ...withT3ThreadEnvironment(
        {},
        input.threadId,
        input.environmentId,
        yield* railsAgentIdOfCwd(input.cwd),
      ),
    };
    const config = yield* input
      .readConfig(input.cwd)
      .pipe(
        Effect.catch(() =>
          Effect.logWarning("Codex config read failed; MCP servers get no thread env.").pipe(
            Effect.as(undefined),
          ),
        ),
      );
    const mcpServers = isRecord(config) && isRecord(config.config) ? config.config.mcp_servers : {};
    return codexThreadEnvironmentConfig(variables, mcpServers);
  },
);
