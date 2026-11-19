import { CloudSpeechProvider, type EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentPresentation } from "../state/environments";

export const OFF = "off";

export function voiceDestinationChoices(environments: ReadonlyArray<EnvironmentPresentation>) {
  const environmentChoices = environments.map((environment) => ({
    environment,
    value: JSON.stringify(["environment", environment.environmentId]),
  }));
  const cloudGroups = environments
    .filter(
      (environment) => environment.serverConfig?.environment.capabilities.cloudVoiceTranscription,
    )
    .map((environment) => ({
      environment,
      choices: CloudSpeechProvider.literals.map((provider) => ({
        environment,
        provider,
        value: JSON.stringify(["cloud", environment.environmentId, provider]),
      })),
    }));
  return {
    environmentChoices,
    cloudGroups,
    cloudChoices: cloudGroups.flatMap((group) => group.choices),
  };
}

export function voiceDestinationValue(destination: {
  readonly environmentId: EnvironmentId | null;
  readonly cloudProvider?: CloudSpeechProvider;
}) {
  if (destination.cloudProvider)
    return JSON.stringify(["cloud", destination.environmentId, destination.cloudProvider]);
  return destination.environmentId
    ? JSON.stringify(["environment", destination.environmentId])
    : OFF;
}
