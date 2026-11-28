import * as Effect from "effect/Effect";
import {
  AGENT_HOME_KEY_PREFIX,
  agentHomeKeyOfRoot,
  agentHomeKeysOfRoot,
  parseAgentHomeKey,
} from "../agents/AgentHomeOfPath.ts";
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

export const projectsMatchingAgentHome = Effect.fn("ProjectsByRepository.matchingAgentHome")(
  function* (projects: ProjectService.ProjectService["Service"], wanted: ReadonlySet<string>) {
    const exactRoots = new Set<string>();
    const targets = new Set<string>();
    for (const key of wanted) {
      if (key.startsWith(AGENT_HOME_KEY_PREFIX))
        exactRoots.add(key.slice(AGENT_HOME_KEY_PREFIX.length));
      const parsed = parseAgentHomeKey(key);
      if (parsed !== undefined) targets.add(`${parsed.handle}\u0000${parsed.executor ? "1" : "0"}`);
    }
    if (exactRoots.size === 0 && targets.size === 0) return { matches: [], complete: true };
    const candidates = yield* scan(projects, (project) => project.repositoryIdentity == null);
    const exact = candidates.matches.filter((project) => exactRoots.has(project.workspaceRoot));
    if (exact.length === 1) return { matches: exact, complete: candidates.complete };
    if (targets.size === 0) return { matches: exact, complete: candidates.complete };
    const matches: Array<Listed> = [];
    for (const project of candidates.matches) {
      const keys = yield* Effect.promise(() => agentHomeKeysOfRoot(project.workspaceRoot));
      const matched = keys.some((key) => {
        const parsed = parseAgentHomeKey(key);
        return (
          parsed !== undefined &&
          targets.has(`${parsed.handle}\u0000${parsed.executor ? "1" : "0"}`)
        );
      });
      if (matched) matches.push(project);
    }
    return { matches, complete: candidates.complete };
  },
);
