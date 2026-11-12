import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

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
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
const guidanceSections = (guidance: string): ReadonlyArray<string> => {
  const sections: Array<string> = [];
  let current = "";
  for (const paragraph of guidance.split(/\n{2,}/)) {
    const next = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (Buffer.byteLength(next, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
      current = next;
      continue;
    }
    if (current.length > 0) sections.push(current);
    current = paragraph;
  }
  if (current.trim().length > 0) sections.push(current);
  return sections;
};

export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
  toolGuidance?: string,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolGuidance === undefined ? toolInstructions(toolsAvailable) : "";
  const sections =
    toolGuidance === undefined ? T3_CODE_ORCHESTRATION_SECTIONS : guidanceSections(toolGuidance);
  return {
    ...Object.fromEntries(
      sections.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
