import * as Effect from "effect/Effect";
import { agentHomeKeyOfRoot } from "../agents/AgentHomeOfPath.ts";
import type * as Identities from "../project/RepositoryIdentityResolver.ts";
import type * as ServerSettings from "../serverSettings.ts";

interface Listed {
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
}

export const remoteProjectMatch = Effect.fn("RemoteProjectMatch.match")(function* (
  identities: Identities.RepositoryIdentityResolver["Service"],
  settings: ServerSettings.ServerSettingsService["Service"],
  repository: string | undefined,
  workspaceRoot: string | undefined,
) {
  const byKey = (key: string) => ({
    key,
    matches: (project: Listed) => project.repositoryIdentity?.canonicalKey === key,
  });
  if (repository !== undefined) return byKey(repository);
  if (workspaceRoot === undefined) return undefined;
  const canonical = (yield* identities.resolve(workspaceRoot))?.canonicalKey;
  if (canonical !== undefined) return byKey(canonical);
  const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  if (current?.agentPlacementSpillWhenFull !== true) return undefined;
  const home = yield* Effect.promise(() => agentHomeKeyOfRoot(workspaceRoot));
  return home === undefined
    ? undefined
    : {
        key: home,
        matches: (project: Listed) =>
          project.repositoryIdentity == null && project.workspaceRoot === workspaceRoot,
      };
});
