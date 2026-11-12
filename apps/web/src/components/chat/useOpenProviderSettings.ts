import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { readEmbedLocation } from "../../embed/embedLocation";

export type ProviderSettingsTarget = {
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
};

export function useOpenProviderSettings(): (target?: ProviderSettingsTarget) => void {
  const navigate = useNavigate();
  return (target = {}) => {
    const embed = readEmbedLocation(window.location.pathname);
    if (embed === null) {
      void navigate({ to: "/settings/providers", search: target });
      return;
    }
    void navigate({
      to: "/embed/$environmentId/providers",
      params: { environmentId: target.environmentId ?? embed.environmentId },
      search: {
        ...(embed.threadId ? { thread: embed.threadId } : {}),
        ...(target.instanceId ? { instanceId: target.instanceId } : {}),
      },
    });
  };
}
