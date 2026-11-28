import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  boundAgentsKernel,
  buildRuntimeInstructions,
} from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly agentsKernel?: string | undefined;
}

/** Resolve global AGENTS.md kernel when RAILS_AGENTS_KERNEL overrides or ~/.codex/AGENTS.md is absent. */
export const resolveCodexAgentsKernel = Effect.fn("resolveCodexAgentsKernel")(function* (input: {
  readonly cwd: string | null;
  readonly userHome: string;
  readonly codexHome?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = input.environment ?? process.env;
  const codexHomeRaw = input.codexHome?.trim() || environment.CODEX_HOME?.trim();
  const codexHome = codexHomeRaw
    ? path.resolve(expandHomePath(codexHomeRaw, input.userHome))
    : path.join(input.userHome, ".codex");
  const realCodexAgentsMd = yield* fileSystem
    .realPath(path.join(codexHome, "AGENTS.md"))
    .pipe(Effect.orElseSucceed(() => undefined));
  const realWorkspaceAgentsMd =
    input.cwd === null
      ? undefined
      : yield* fileSystem
          .realPath(path.resolve(input.cwd, "AGENTS.md"))
          .pipe(Effect.orElseSucceed(() => undefined));

  const configuredKernel = environment.RAILS_AGENTS_KERNEL?.trim();
  if (configuredKernel) {
    const realConfigured = yield* fileSystem
      .realPath(path.resolve(expandHomePath(configuredKernel, input.userHome)))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (realConfigured !== undefined) {
      if (realConfigured === realCodexAgentsMd || realConfigured === realWorkspaceAgentsMd) {
        return undefined;
      }
      const contents = yield* fileSystem
        .readFileString(realConfigured)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents !== undefined) {
        const bounded = boundAgentsKernel(contents);
        if (bounded !== undefined) return bounded;
      }
    }
  }

  if (realCodexAgentsMd !== undefined) {
    return undefined;
  }

  const realAgentsMd = yield* fileSystem
    .realPath(path.join(input.userHome, ".agents", "AGENTS.md"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (realAgentsMd === undefined || realAgentsMd === realWorkspaceAgentsMd) {
    return undefined;
  }
  const contents = yield* fileSystem
    .readFileString(realAgentsMd)
    .pipe(Effect.orElseSucceed(() => undefined));
  return contents === undefined ? undefined : boundAgentsKernel(contents);
});

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  const boundedKernel =
    runtime.agentsKernel === undefined ? undefined : boundAgentsKernel(runtime.agentsKernel);
  const { agentsKernel: _agentsKernel, ...runtimeInfo } = runtime;
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtimeInfo }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
    ...(boundedKernel
      ? {
          t3_code_agents_kernel: {
            kind: "application" as const,
            value: `<agents_kernel>\n${boundedKernel}\n</agents_kernel>`,
          },
        }
      : {}),
  };
}
