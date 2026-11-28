import * as Effect from "effect/Effect";
import {
  AGENT_HOME_KEY_PREFIX,
  agentHomeKeyOfRoot,
  agentHomeKeysOfRoot,
  isAgentShellHomeRoot,
  parseAgentHomeKey,
} from "../agents/AgentHomeOfPath.ts";
import type * as ProjectService from "./ProjectService.ts";
import { repositoryIdentityKeys } from "./RepositoryIdentityKeys.ts";

type Page = Effect.Success<ReturnType<ProjectService.ProjectService["Service"]["listPage"]>>;
type Listed = Page["projects"][number];

const disambiguateAgentHomeMatches = Effect.fn("ProjectsByRepository.disambiguateAgentHome")(
  function* (matches: ReadonlyArray<Listed>, exactRoots: ReadonlySet<string>) {
    if (matches.length <= 1) return matches;
    const active = matches.filter((project) => project.archivedAt == null);
    const pool = active.length > 0 ? active : matches;
    if (pool.length === 1) return pool;
    const shells: Array<Listed> = [];
    for (const project of pool) {
      if (yield* Effect.promise(() => isAgentShellHomeRoot(project.workspaceRoot))) {
        shells.push(project);
      }
    }
    if (shells.length === 1) return shells;
    const exact = pool.filter((project) => exactRoots.has(project.workspaceRoot));
    if (exact.length === 1) return exact;
    return pool;
  },
);

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
    if (targets.size === 0) {
      const exact = candidates.matches.filter((project) => exactRoots.has(project.workspaceRoot));
      return {
        matches: yield* disambiguateAgentHomeMatches(exact, exactRoots),
        complete: candidates.complete,
      };
    }
    const matches: Array<Listed> = [];
    for (const project of candidates.matches) {
      const keys = yield* Effect.promise(() => agentHomeKeysOfRoot(project.workspaceRoot));
      const matched =
        exactRoots.has(project.workspaceRoot) ||
        keys.some((key) => {
          const parsed = parseAgentHomeKey(key);
          return (
            parsed !== undefined &&
            targets.has(`${parsed.handle}\u0000${parsed.executor ? "1" : "0"}`)
          );
        });
      if (matched) matches.push(project);
    }
    return {
      matches: yield* disambiguateAgentHomeMatches(matches, exactRoots),
      complete: candidates.complete,
    };
  },
);
