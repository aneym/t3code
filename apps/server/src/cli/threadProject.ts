import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../os-jank.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { OwnerMcpTools } from "./ownerMcpTools.ts";
import { ThreadProjectNotFoundError, ThreadUsageError } from "./threadCommon.ts";

const ProjectListResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({ id: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
  ),
  nextCursor: Schema.NullOr(Schema.Int),
});

const listAllProjects = Effect.fn("cli.thread.listAllProjects")(function* (tools: OwnerMcpTools) {
  const projects: Array<(typeof ProjectListResult.Type)["projects"][number]> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: typeof ProjectListResult.Type = yield* tools.call(
      "t3_project_list",
      { cursor, limit: 100 },
      ProjectListResult,
    );
    projects.push(...page.projects);
    cursor = page.nextCursor;
  }
  return projects;
});

const listGitCheckouts = Effect.fn("cli.thread.listGitCheckouts")(function* (directory: string) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const list = (args: ReadonlyArray<string>) =>
    processRunner
      .run({ command: "git", args: ["worktree", "list", "--porcelain", ...args], cwd: directory })
      .pipe(
        Effect.option,
        Effect.map((result) =>
          Option.isSome(result) && result.value.code === 0 ? result.value.stdout : undefined,
        ),
      );
  // Pre-2.36 Git rejects worktree list -z; normalize its line output to NUL records.
  const stdout = (yield* list(["-z"])) ?? (yield* list([]))?.replaceAll("\n", "\0") ?? "";
  return stdout.split("\0\0").flatMap((record) => {
    const [first = "", ...attributes] = record.split("\0");
    return first.startsWith("worktree ") && !attributes.includes("bare")
      ? [first.slice("worktree ".length)]
      : [];
  });
});

export const resolveProject = Effect.fn("cli.thread.resolveProject")(function* (
  tools: OwnerMcpTools,
  identifier: string,
) {
  const projects = yield* listAllProjects(tools);
  const byId = projects.find((project) => project.id === identifier);
  if (byId !== undefined) return byId;

  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  // Stored roots keep the path the project was added with, which may pass
  // through a symlink (macOS /tmp), so both sides compare as real paths.
  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const target = yield* realPath(
    path.resolve(yield* HostProcess.WorkingDirectory, yield* expandHomePath(identifier)),
  );
  const roots = yield* Effect.forEach(projects, (project) =>
    Effect.map(realPath(project.workspaceRoot), (root) => ({ project, root })),
  );
  const contains = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const deepestContaining = (candidate: string) =>
    roots
      .filter(({ root }) => contains(root, candidate))
      .toSorted((left, right) => right.root.length - left.root.length)[0]?.project;

  const containing = deepestContaining(target);
  if (containing !== undefined) return containing;
  const targetInfo = yield* fileSystem.stat(target).pipe(Effect.option);
  const gitDirectory =
    Option.isSome(targetInfo) && targetInfo.value.type === "File" ? path.dirname(target) : target;
  const listed = yield* listGitCheckouts(gitDirectory).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, realPath)),
    Effect.provide(ProcessRunner.layer),
  );
  const ownCheckout = listed
    .filter((checkout) => contains(checkout, target))
    .toSorted((left, right) => right.length - left.length)[0];
  if (ownCheckout === undefined) {
    return yield* new ThreadProjectNotFoundError({ identifier });
  }
  const relative = path.relative(ownCheckout, target);
  const matches = new Map<ProjectId, (typeof projects)[number]>();
  for (const checkout of listed) {
    if (checkout === ownCheckout) continue;
    const project = deepestContaining(path.join(checkout, relative));
    if (project !== undefined) matches.set(project.id, project);
  }
  const [match, ...others] = matches.values();
  if (match === undefined) {
    return yield* new ThreadProjectNotFoundError({ identifier });
  }
  if (others.length > 0) {
    const names = [match, ...others].map((project) => `${project.title} (${project.id})`);
    return yield* new ThreadUsageError({
      detail: `'${identifier}' is in a git worktree shared by several projects: ${names.join(", ")}. Pass a project id instead.`,
    });
  }
  return match;
});
