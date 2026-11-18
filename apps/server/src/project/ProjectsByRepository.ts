import * as Effect from "effect/Effect";
import type * as ProjectService from "./ProjectService.ts";
import { repositoryIdentityKeys } from "./RepositoryIdentityKeys.ts";

type Page = Effect.Success<ReturnType<ProjectService.ProjectService["Service"]["listPage"]>>;

export const projectsByRepository = Effect.fn("ProjectsByRepository.find")(function* (
  projects: ProjectService.ProjectService["Service"],
  wanted: ReadonlySet<string>,
) {
  const matches: Array<Page["projects"][number]> = [];
  let cursor: number | null = 0;
  let pages = 0;
  while (cursor !== null && pages++ < 10) {
    const page: Page = yield* projects.listPage({ cursor, limit: 100 });
    matches.push(
      ...page.projects.filter((project) =>
        repositoryIdentityKeys(project.repositoryIdentity).some((key) => wanted.has(key)),
      ),
    );
    cursor = page.nextCursor;
  }
  return { matches, complete: cursor === null };
});
