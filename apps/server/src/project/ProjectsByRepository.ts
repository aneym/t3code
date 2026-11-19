import * as Effect from "effect/Effect";
import { AGENT_HOME_KEY_PREFIX, agentHomeKeyOfRoot } from "../agents/AgentHomeOfPath.ts";
import type * as ProjectService from "./ProjectService.ts";
import { repositoryIdentityKeys } from "./RepositoryIdentityKeys.ts";

type Page = Effect.Success<ReturnType<ProjectService.ProjectService["Service"]["listPage"]>>;
type Listed = Page["projects"][number];

const homeMatch = (wanted: ReadonlySet<string>) => {
  const handles = [...wanted]
    .filter((key) => key.startsWith(AGENT_HOME_KEY_PREFIX))
    .map((key) => key.slice(AGENT_HOME_KEY_PREFIX.length));
  return (project: Listed) =>
    handles.length === 0 ||
    project.repositoryIdentity != null ||
    !handles.some((handle) => project.workspaceRoot.endsWith(`/${handle}`))
      ? Effect.succeed(false)
      : Effect.promise(() => agentHomeKeyOfRoot(project.workspaceRoot)).pipe(
          Effect.map((key) => key !== undefined && wanted.has(key)),
        );
};

export const projectsByRepository = Effect.fn("ProjectsByRepository.find")(function* (
  projects: ProjectService.ProjectService["Service"],
  wanted: ReadonlySet<string>,
) {
  const home = homeMatch(wanted);
  const matches: Array<Listed> = [];
  let cursor: number | null = 0;
  let pages = 0;
  while (cursor !== null && pages++ < 10) {
    const page: Page = yield* projects.listPage({ cursor, limit: 100 });
    for (const project of page.projects)
      if (
        repositoryIdentityKeys(project.repositoryIdentity).some((key) => wanted.has(key)) ||
        (yield* home(project))
      )
        matches.push(project);
    cursor = page.nextCursor;
  }
  return { matches, complete: cursor === null };
});
