import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { sealedAgentHomeFor, type SealedAgentHome } from "../../agents/SealedAgentHome.ts";

export const readClaudeSealedHome = (cwd: string | null) =>
  Effect.promise((): Promise<SealedAgentHome | null> =>
    sealedAgentHomeFor(cwd).catch(() => ({ home: "", mcpServers: {} })),
  );

export const sealedClaudeSettings = (home: SealedAgentHome | null, settings: ClaudeSettings) =>
  home === null ? settings : { ...settings, launchArgs: "" };

export const sealClaudeQuery = <T extends object>(home: SealedAgentHome | null, options: T): T =>
  home === null
    ? options
    : {
        ...options,
        settingSources: ["project", "local"] satisfies Options["settingSources"],
        strictMcpConfig: true,
        mcpServers: home.mcpServers as Record<string, McpServerConfig>,
      };
