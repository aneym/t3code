import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { MAX_AGENTS_KERNEL_BYTES } from "@t3tools/provider-core/server/runtimeInstructions";
import { discoverAntigravitySkills, resolveAntigravityAgentsKernel } from "./AntigravitySkills.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const writeSkill = Effect.fn("writeSkill")(function* (directory: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const skillPath = path.join(directory, "SKILL.md");
  yield* fileSystem.writeFileString(skillPath, contents);
  return skillPath;
});

const makeWorkspace = Effect.fn("makeWorkspace")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-antigravity-skills-",
  });
  return {
    cwd: path.join(temporaryDirectory, "workspace"),
    userHome: path.join(temporaryDirectory, "home"),
  };
});

it.layer(NodeServices.layer)("discoverAntigravitySkills", (it) => {
  it.effect("discovers canonical user skills from ~/.agents/skills even in nested projects", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const nested = { ...input, cwd: path.join(input.userHome, "AI", "Projects", "Something") };
      const reviewPath = yield* writeSkill(
        path.join(input.userHome, ".gemini", "config", "skills", "review"),
        "---\nname: review\ndescription: Review changes.\n---\n",
      );
      const canonicalPath = yield* writeSkill(
        path.join(input.userHome, ".agents", "skills", "canonical"),
        "---\nname: canonical\ndescription: Canonical skill.\n---\n",
      );

      assert.deepEqual(yield* discoverAntigravitySkills({ ...nested, environment: {} }), [
        {
          name: "canonical",
          description: "Canonical skill.",
          path: canonicalPath,
          scope: "user",
          enabled: true,
        },
        {
          name: "review",
          description: "Review changes.",
          path: reviewPath,
          scope: "user",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("reads skill names, descriptions and paths from the current native roots", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const roots = [
        { directory: path.join(input.userHome, ".gemini", "config", "skills"), scope: "user" },
        { directory: path.join(input.cwd, ".gemini", "skills"), scope: "project" },
        {
          directory: path.join(input.userHome, ".gemini", "antigravity-cli", "skills"),
          scope: "user",
        },
        { directory: path.join(input.cwd, ".agents", "skills"), scope: "project" },
      ];
      const expected = [];
      for (const [index, root] of roots.entries()) {
        const name = `review-${index}`;
        const description = `Review changes in root ${index}.`;
        const skillPath = yield* writeSkill(
          path.join(root.directory, name),
          `---\nname: ${name}\ndescription: ${description}\n---\n# Review\n`,
        );
        expected.push({ name, description, path: skillPath, scope: root.scope, enabled: true });
      }

      assert.deepEqual(yield* discoverAntigravitySkills(input), expected);
    }),
  );

  it.effect("uses native root order for duplicate names", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const roots = [
        path.join(input.userHome, ".gemini", "config", "skills"),
        path.join(input.cwd, ".gemini", "skills"),
        path.join(input.userHome, ".gemini", "antigravity-cli", "skills"),
        path.join(input.cwd, ".agents", "skills"),
        path.join(input.cwd, ".agent", "skills"),
      ];
      for (const [index, root] of roots.entries()) {
        yield* writeSkill(
          path.join(root, `copy-${index}`),
          `---\nname: review\ndescription: Copy ${index}.\n---\n`,
        );
      }

      for (const [index, root] of roots.entries()) {
        const skills = yield* discoverAntigravitySkills(input);
        assert.equal(skills.length, 1);
        assert.equal(skills[0]?.path, path.join(root, `copy-${index}`, "SKILL.md"));
        yield* fileSystem.remove(root, { recursive: true });
      }
    }),
  );

  it.effect("loads a root skill without scanning its children", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      const skillPath = yield* writeSkill(root, "---\nname: root-skill\n---\n");
      yield* writeSkill(path.join(root, "child"), "---\nname: child-skill\n---\n");

      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        { name: "root-skill", path: skillPath, scope: "project", enabled: true },
      ]);

      yield* fileSystem.writeFileString(skillPath, "---\nname: [invalid\n---\n");
      assert.deepEqual(yield* discoverAntigravitySkills(input), []);
    }),
  );

  it.effect("uses the filename when valid frontmatter has no name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const skillPath = yield* writeSkill(
        path.join(input.cwd, ".agents", "skills", "not-the-name"),
        "---\n---\n# Skill body\n",
      );

      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        { name: "SKILL", path: skillPath, scope: "project", enabled: true },
      ]);

      const lowerCasePath = path.join(path.dirname(skillPath), "skill.md");
      yield* fileSystem.rename(skillPath, lowerCasePath);
      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        { name: "skill", path: lowerCasePath, scope: "project", enabled: true },
      ]);

      yield* fileSystem.rename(lowerCasePath, path.join(path.dirname(skillPath), "SKILL.MD"));
      assert.deepEqual(yield* discoverAntigravitySkills(input), []);
    }),
  );

  it.effect("accepts native metadata delimiters after leading text", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const skillPath = yield* writeSkill(
        path.join(input.cwd, ".agents", "skills", "review"),
        "Leading text.---\nname: review\ndescription: null\n---Skill body.",
      );

      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        { name: "review", path: skillPath, scope: "project", enabled: true },
      ]);
    }),
  );

  it.effect("ignores invalid files and deeper directories but keeps native hidden skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      const invalidSkills = [
        ["plain", "# Missing frontmatter\n"],
        ["broken", "---\nname: [unclosed\n---\n"],
        ["scalar", "---\n42\n---\n"],
        ["wrong-type", "---\nname: invalid\ndescription: {}\n---\n"],
        ["blank-name", '---\nname: " "\n---\n'],
      ] as const;
      for (const [name, contents] of invalidSkills) {
        yield* writeSkill(path.join(root, name), contents);
      }
      yield* writeSkill(path.join(root, "nested", "deep"), "---\nname: too-deep\n---\n");
      yield* writeSkill(
        path.join(input.cwd, ".claude", "skills", "wrong-provider"),
        "---\nname: wrong-provider\n---\n",
      );
      yield* fileSystem.makeDirectory(path.join(root, ".not-a-skill"));
      yield* fileSystem.writeFileString(path.join(root, "README.md"), "Not a skill.");
      const skillPath = yield* writeSkill(
        path.join(root, ".native-hidden-skill"),
        "---\nname: native-name\ndescription: >\n  Review the code\n  and run tests.\n---\n",
      );

      assert.deepEqual(yield* discoverAntigravitySkills(input), [
        {
          name: "native-name",
          description: "Review the code and run tests.",
          path: skillPath,
          scope: "project",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("uses native URI order within a root and skips an invalid higher root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      yield* writeSkill(
        path.join(input.userHome, ".gemini", "config", "skills", "review"),
        "---\nname: [invalid\n---\n",
      );
      const nativeOrder = [" space-copy", "!-copy", "ø-copy", "a-copy"];
      for (const name of nativeOrder) {
        yield* writeSkill(path.join(root, name), "---\nname: review\n---\n");
      }

      for (const name of nativeOrder) {
        assert.deepEqual(yield* discoverAntigravitySkills(input), [
          {
            name: "review",
            path: path.join(root, name, "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        yield* fileSystem.remove(path.join(root, name), { recursive: true });
      }
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "follows directory symlinks used to install shared skills",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* makeWorkspace();
        const sourceDirectory = path.join(input.userHome, "shared-review");
        yield* writeSkill(sourceDirectory, "---\nname: review\n---\n");
        const root = path.join(input.cwd, ".agents", "skills");
        const linkedDirectory = path.join(root, "review");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* fileSystem.symlink(sourceDirectory, linkedDirectory);

        assert.deepEqual(yield* discoverAntigravitySkills(input), [
          {
            name: "review",
            path: path.join(linkedDirectory, "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
      }),
  );

  it.effect("rejects an oversized skill instead of returning an incomplete catalog", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const skillPath = yield* writeSkill(
        path.join(input.cwd, ".agents", "skills", "oversized"),
        `---\nname: oversized\ndescription: Read a large skill.\n---\n${"x".repeat(1_000_000)}`,
      );

      const result = yield* discoverAntigravitySkills(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "scan-budget-exhausted");
        assert.equal(result.failure.path, skillPath);
      }
    }),
  );

  it.effect("bounds the total read size across skills", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = yield* makeWorkspace();
      const root = path.join(input.cwd, ".agents", "skills");
      for (let index = 0; index < 9; index += 1) {
        yield* writeSkill(
          path.join(root, `large-${index}`),
          `---\nname: large-${index}\n---\n${"x".repeat(900_000)}`,
        );
      }

      const result = yield* discoverAntigravitySkills(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "scan-budget-exhausted");
        assert.equal(result.failure.path, path.join(root, "large-8", "SKILL.md"));
      }
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "honors RAILS_SKILLS_DIR priority and deduplicates symlinks across user roots",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* makeWorkspace();
        const railsDir = path.join(input.userHome, "rails-skills");
        const agentsDir = path.join(input.userHome, ".agents", "skills");
        const cliDir = path.join(input.userHome, ".gemini", "antigravity-cli", "skills");

        const railsAlpha = yield* writeSkill(
          path.join(railsDir, "alpha"),
          "---\nname: alpha\ndescription: From RAILS_SKILLS_DIR.\n---\n",
        );
        yield* writeSkill(
          path.join(agentsDir, "alpha"),
          "---\nname: alpha\ndescription: From ~/.agents/skills.\n---\n",
        );
        const agentsBeta = yield* writeSkill(
          path.join(agentsDir, "beta"),
          "---\nname: beta\ndescription: Shared canonical skill.\n---\n",
        );
        yield* fileSystem.makeDirectory(cliDir, { recursive: true });
        yield* fileSystem.symlink(path.join(agentsDir, "beta"), path.join(cliDir, "beta-alias"));

        const skills = yield* discoverAntigravitySkills({
          ...input,
          environment: { RAILS_SKILLS_DIR: railsDir },
        });
        assert.deepEqual(skills, [
          {
            name: "alpha",
            description: "From RAILS_SKILLS_DIR.",
            path: railsAlpha,
            scope: "user",
            enabled: true,
          },
          {
            name: "beta",
            description: "Shared canonical skill.",
            path: agentsBeta,
            scope: "user",
            enabled: true,
          },
        ]);
      }),
  );

  it.effect(
    "resolves bounded AGENTS.md kernel with RAILS_AGENTS_KERNEL > ~/.agents > ~/.gemini precedence",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const input = yield* makeWorkspace();
        const agentsKernel = path.join(input.userHome, ".agents", "AGENTS.md");
        const geminiKernel = path.join(input.userHome, ".gemini", "AGENTS.md");
        const overrideKernel = path.join(input.userHome, "override-AGENTS.md");
        yield* fileSystem.makeDirectory(path.dirname(agentsKernel), { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(geminiKernel), { recursive: true });
        yield* fileSystem.makeDirectory(input.cwd, { recursive: true });

        yield* fileSystem.writeFileString(geminiKernel, "from-gemini");
        assert.equal(
          yield* resolveAntigravityAgentsKernel({ ...input, environment: {} }),
          "from-gemini",
        );

        yield* fileSystem.writeFileString(agentsKernel, "from-agents");
        assert.equal(
          yield* resolveAntigravityAgentsKernel({ ...input, environment: {} }),
          "from-agents",
        );

        yield* fileSystem.writeFileString(overrideKernel, "x".repeat(MAX_AGENTS_KERNEL_BYTES * 2));
        const bounded = yield* resolveAntigravityAgentsKernel({
          ...input,
          environment: { RAILS_AGENTS_KERNEL: overrideKernel },
        });
        assert.isDefined(bounded);
        assert.isAtMost(Buffer.byteLength(bounded!, "utf8"), MAX_AGENTS_KERNEL_BYTES);

        // Skip when the selected kernel is already the workspace AGENTS.md.
        const workspaceAgents = path.join(input.cwd, "AGENTS.md");
        yield* fileSystem.writeFileString(workspaceAgents, "workspace-kernel");
        assert.equal(
          yield* resolveAntigravityAgentsKernel({
            ...input,
            environment: { RAILS_AGENTS_KERNEL: workspaceAgents },
          }),
          undefined,
        );
      }),
  );
});
