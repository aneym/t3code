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
