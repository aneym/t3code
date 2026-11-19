import * as Effect from "effect/Effect";
import { agentHomeKeyOfRoot } from "../agents/AgentHomeOfPath.ts";
import type * as ProjectService from "./ProjectService.ts";
import { repositoryIdentityKeys } from "./RepositoryIdentityKeys.ts";

type Page = Effect.Success<ReturnType<ProjectService.ProjectService["Service"]["listPage"]>>;
type Listed = Page["projects"][number];

const scan = Effect.fn("ProjectsByRepository.scan")(function* (
  projects: ProjectService.ProjectService["Service"],
  keep: (project: Listed) => boolean,
) {
  const matches: Array<Listed> = [];
  let cursor: number | null = 0;
  let pages = 0;
  while (cursor !== null && pages++ < 10) {
    const page: Page = yield* projects.listPage({ cursor, limit: 100 });
    matches.push(...page.projects.filter(keep));
    cursor = page.nextCursor;
  }
  return { matches, complete: cursor === null };
});

export const projectsByRepository = Effect.fn("ProjectsByRepository.find")(function* (
  projects: ProjectService.ProjectService["Service"],
  wanted: ReadonlySet<string>,
) {
  return yield* scan(projects, (project) =>
    repositoryIdentityKeys(project.repositoryIdentity).some((key) => wanted.has(key)),
  );
});

export const projectsAtAgentHome = Effect.fn("ProjectsByRepository.atAgentHome")(function* (
  projects: ProjectService.ProjectService["Service"],
  workspaceRoot: string,
) {
  if ((yield* Effect.promise(() => agentHomeKeyOfRoot(workspaceRoot))) === undefined)
    return { matches: [], complete: true };
  return yield* scan(
    projects,
    (project) => project.repositoryIdentity == null && project.workspaceRoot === workspaceRoot,
  );
});
