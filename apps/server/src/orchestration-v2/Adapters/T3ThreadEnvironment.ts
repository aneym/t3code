import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";

export const currentEnvironmentId: Effect.Effect<string | undefined> = Effect.serviceOption(
  ServerEnvironment.ServerEnvironmentIdentity,
).pipe(
  Effect.flatMap((identity) =>
    Option.isSome(identity) ? identity.value.getEnvironmentId : Effect.undefined,
  ),
);

export function withT3ThreadEnvironment(
  environment: NodeJS.ProcessEnv,
  threadId: string,
  environmentId: string | undefined,
): NodeJS.ProcessEnv {
  if (environmentId === undefined) return environment;
  return {
    ...environment,
    T3_THREAD_ID: threadId,
    T3_ENVIRONMENT_ID: environmentId,
  };
}
