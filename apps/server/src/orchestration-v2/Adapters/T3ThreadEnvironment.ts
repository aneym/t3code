import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { railsAgentIdOfPath } from "../../agents/AgentHomeRailsId.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

export const currentEnvironmentId: Effect.Effect<string | undefined> = Effect.serviceOption(
  ServerEnvironment.ServerEnvironmentIdentity,
).pipe(
  Effect.flatMap((identity) =>
    Option.isSome(identity) ? identity.value.getEnvironmentId : Effect.undefined,
  ),
);

export const railsAgentIdOfCwd = (cwd: string | null | undefined) =>
  Effect.promise(() => railsAgentIdOfPath(cwd));

export function withT3ThreadEnvironment(
  environment: NodeJS.ProcessEnv,
  threadId: string,
  environmentId: string | undefined,
  railsAgentId: string | undefined,
): NodeJS.ProcessEnv {
  const base = { ...environment };
  delete base.T3_RAILS_AGENT_ID;
  if (environmentId === undefined) return base;
  return {
    ...base,
    T3_THREAD_ID: threadId,
    T3_ENVIRONMENT_ID: environmentId,
    ...(railsAgentId === undefined ? {} : { T3_RAILS_AGENT_ID: railsAgentId }),
  };
}
