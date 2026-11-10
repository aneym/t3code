import { useAtomValue } from "@effect/atom-react";
import {
  isManagedDriverAllowed,
  type EnvironmentId,
  type ManagedPolicySummary,
  type ProviderDriverKind,
} from "@t3tools/contracts";

import { inEmbedPage } from "../../embed/embedProtocol";
import { providersIgnoringCheckedAtAtom } from "../../state/server";

export function useOfferedDriver(
  environmentId: EnvironmentId,
  managedPolicy: ManagedPolicySummary | undefined,
): (driver: ProviderDriverKind) => boolean {
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const embedded = inEmbedPage();
  return (driver) =>
    isManagedDriverAllowed(managedPolicy, driver) &&
    (!embedded || providers.some((provider) => provider.driver === driver));
}
