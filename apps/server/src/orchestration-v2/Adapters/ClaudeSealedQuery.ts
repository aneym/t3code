// @effect-diagnostics nodeBuiltinImport:off -- the SDK spawn env is built synchronously from Claude's own settings file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { sealedAgentHomeFor, type SealedAgentHome } from "../../agents/SealedAgentHome.ts";

const LOGIN_ENV_KEY =
  /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_SKIP_|AWS_|VERTEX_REGION_)|^(CLOUD_ML_REGION|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY_HELPER_TTL_MS|GOOGLE_APPLICATION_CREDENTIALS|HTTPS_PROXY|HTTP_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS)$/;

const userLoginEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const dir =
    env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(env.HOME?.trim() || NodeOS.homedir(), ".claude");
  try {
    const user: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(dir, "settings.json"), "utf8"),
    );
    const settingsEnv: unknown =
      typeof user === "object" && user !== null && "env" in user ? user.env : undefined;
    if (typeof settingsEnv !== "object" || settingsEnv === null) return {};
    return Object.fromEntries(
      Object.entries(settingsEnv).flatMap(([key, value]) =>
        LOGIN_ENV_KEY.test(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
          ? [[key, String(value)]]
          : [],
      ),
    );
  } catch {
    return {};
  }
};

export const readClaudeSealedHome = (cwd: string | null) =>
  Effect.promise((): Promise<SealedAgentHome | null> =>
    sealedAgentHomeFor(cwd).catch(() => ({ home: "", mcpServers: {} })),
  );

export const sealedClaudeSettings = (home: SealedAgentHome | null, settings: ClaudeSettings) =>
  home === null ? settings : { ...settings, launchArgs: "" };

const spawnEnv = (options: object): NodeJS.ProcessEnv | undefined =>
  "env" in options && typeof options.env === "object" && options.env !== null
    ? (options.env as NodeJS.ProcessEnv)
    : undefined;

export const sealClaudeQuery = <T extends object>(home: SealedAgentHome | null, options: T): T => {
  if (home === null) return options;
  const env = spawnEnv(options);
  return {
    ...options,
    ...(env === undefined ? {} : { env: { ...userLoginEnv(env), ...env } }),
    settingSources: ["project", "local"] satisfies Options["settingSources"],
    strictMcpConfig: true,
    mcpServers: home.mcpServers as Record<string, McpServerConfig>,
  };
};
