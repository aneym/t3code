import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_CODE_DEVICE_TOOL_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { MAX_AGENTS_KERNEL_BYTES } from "@t3tools/provider-core/server/runtimeInstructions";
import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
  resolveCodexAgentsKernel,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
  ])("with runtime $model", (runtime) => {
    it.each([undefined, { browser: true, device: true }])(
      "keeps every entry within Codex's per-entry cap with tools %j",
      (availability) => {
        const context = buildCodexAdditionalContext(runtime, availability);

        for (const [key, entry] of Object.entries(context)) {
          // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
          const bytes = Buffer.byteLength(entry.value, "utf8");
          const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
          NodeAssert.ok(
            bytes <= limit,
            `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
          );
        }
      },
    );
  });
});

describe("Codex runtime context", () => {
  it("describes Markdown media support in the runtime context in both modes", () => {
    {
      const instructions = runtimeInstructions({
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images, video, and audio.*Markdown image syntax with absolute file paths.*Link any other file.*absolute path.*files viewer.*<\/runtime_info>/,
      );
    }
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Codex orchestration context", () => {
  it("routes subagents native first, delegate_task for the rest", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(orchestration.includes("use your native tool when the child uses your provider"));
    NodeAssert.ok(orchestration.includes("`run_in_background:false`"));
    NodeAssert.ok(orchestration.includes("A native type running another provider's model"));
    NodeAssert.ok(
      orchestration.includes("Every new delegate review or re-check is a new `delegate_task`"),
    );
    NodeAssert.ok(orchestration.includes("never a `t3_thread_send`"));
    NodeAssert.ok(!orchestration.includes("inheritedOptions"));
    NodeAssert.ok(!orchestration.includes("Prefer native"));
    // The ACP terminal fallback is ACP-only; Codex agents never need it.
    NodeAssert.ok(!orchestration.includes("acp-mcp-call"));
  });
});

describe("Codex device context", () => {
  it("adds the shared device block only when the session holds device access", () => {
    const tools = (device: boolean) =>
      buildCodexAdditionalContext({ model: "gpt-6.1-sol" }, { browser: true, device }).t3_code_tools
        ?.value ?? "";

    NodeAssert.ok(tools(true).includes(T3_CODE_DEVICE_TOOL_INSTRUCTIONS));
    NodeAssert.ok(!tools(true).includes("ToolSearch"));
    NodeAssert.ok(!tools(false).includes("## T3 Code devices"));
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}

describe("Codex agents kernel context", () => {
  it("emits a bounded t3_code_agents_kernel entry within Codex's per-entry cap", () => {
    const context = buildCodexAdditionalContext({
      model: "gpt-6.1-sol",
      agentsKernel: "k".repeat(MAX_AGENTS_KERNEL_BYTES * 2),
    });
    const entry = context.t3_code_agents_kernel;
    NodeAssert.ok(entry !== undefined);
    NodeAssert.ok(entry.value.startsWith("<agents_kernel>\n"));
    NodeAssert.ok(entry.value.endsWith("\n</agents_kernel>"));
    NodeAssert.ok(
      Buffer.byteLength(entry.value, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
    );
  });
});

effectIt.layer(NodeServices.layer)("resolveCodexAgentsKernel", (it) => {
  it.effect(
    "falls back to ~/.agents/AGENTS.md when ~/.codex/AGENTS.md is absent and honors RAILS_AGENTS_KERNEL",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-kernel-" });
        const userHome = path.join(tempDir, "home");
        const cwd = path.join(tempDir, "workspace");
        const agentsMd = path.join(userHome, ".agents", "AGENTS.md");
        const codexMd = path.join(userHome, ".codex", "AGENTS.md");
        const overrideMd = path.join(tempDir, "override-AGENTS.md");

        yield* fs.makeDirectory(path.dirname(agentsMd), { recursive: true });
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* fs.writeFileString(agentsMd, "canonical-agents-kernel");

        NodeAssert.equal(
          yield* resolveCodexAgentsKernel({ cwd, userHome, environment: {} }),
          "canonical-agents-kernel",
        );

        yield* fs.makeDirectory(path.dirname(codexMd), { recursive: true });
        yield* fs.writeFileString(codexMd, "codex-native-kernel");
        NodeAssert.equal(
          yield* resolveCodexAgentsKernel({ cwd, userHome, environment: {} }),
          undefined,
        );

        yield* fs.writeFileString(overrideMd, "override-kernel");
        NodeAssert.equal(
          yield* resolveCodexAgentsKernel({
            cwd,
            userHome,
            environment: { RAILS_AGENTS_KERNEL: overrideMd },
          }),
          "override-kernel",
        );
      }),
  );
});
