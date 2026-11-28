import { assert, it } from "@effect/vitest";

import { applyPreferredCodexDefaultModel, mapCodexModelCapabilities } from "./CodexProvider.ts";

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { augmentCodexSkills } from "./CodexProvider.ts";

effectIt.layer(NodeServices.layer)("augmentCodexSkills", (it) => {
  it.effect.skipIf(!symlinksSupported)(
    "honors RAILS_SKILLS_DIR priority and deduplicates ~/.agents/skills symlinks against app-server skills",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-skills-" });
        const userHome = path.join(tempDir, "home");
        const railsDir = path.join(tempDir, "rails-skills");
        const agentsDir = path.join(userHome, ".agents", "skills");
        const codexSkillsDir = path.join(userHome, ".codex", "skills");

        yield* fs.makeDirectory(path.join(railsDir, "alpha"), { recursive: true });
        const railsAlphaPath = path.join(railsDir, "alpha", "SKILL.md");
        yield* fs.writeFileString(
          railsAlphaPath,
          "---\nname: alpha\ndescription: From RAILS_SKILLS_DIR\n---\n",
        );

        yield* fs.makeDirectory(path.join(agentsDir, "beta"), { recursive: true });
        const agentsBetaPath = path.join(agentsDir, "beta", "SKILL.md");
        yield* fs.writeFileString(
          agentsBetaPath,
          "---\nname: beta\ndescription: From ~/.agents/skills\n---\n",
        );

        yield* fs.makeDirectory(path.join(agentsDir, "gamma"), { recursive: true });
        const agentsGammaPath = path.join(agentsDir, "gamma", "SKILL.md");
        yield* fs.writeFileString(
          agentsGammaPath,
          "---\nname: gamma\ndescription: Only in ~/.agents/skills\n---\n",
        );

        yield* fs.makeDirectory(codexSkillsDir, { recursive: true });
        yield* fs.symlink(path.join(agentsDir, "beta"), path.join(codexSkillsDir, "beta-symlink"));

        const merged = yield* augmentCodexSkills({
          appServerSkills: [
            {
              name: "alpha",
              path: path.join(codexSkillsDir, "alpha", "SKILL.md"),
              enabled: true,
              scope: "user",
              description: "From app-server",
            },
            {
              name: "beta-symlink",
              path: path.join(codexSkillsDir, "beta-symlink", "SKILL.md"),
              enabled: true,
              scope: "user",
              description: "From ~/.codex/skills symlink",
            },
          ],
          environment: { HOME: userHome, RAILS_SKILLS_DIR: railsDir },
        });

        assert.deepStrictEqual(
          merged.map((skill) => ({ name: skill.name, path: skill.path })),
          [
            { name: "alpha", path: railsAlphaPath },
            { name: "beta-symlink", path: path.join(codexSkillsDir, "beta-symlink", "SKILL.md") },
            { name: "gamma", path: agentsGammaPath },
          ],
        );
      }),
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
