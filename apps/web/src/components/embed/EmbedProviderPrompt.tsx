import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentScope } from "../../state/session";
import { useOpenProviderSettings } from "../chat/useOpenProviderSettings";
import { Button } from "../ui/button";

export function EmbedProviderPrompt({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const openProviderSettings = useOpenProviderSettings();
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-5 text-center">
      <p className="text-sm text-foreground">Sign in to Claude or ChatGPT to start</p>
      {canManage ? (
        <Button size="sm" onClick={() => openProviderSettings({ environmentId })}>
          Sign in
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">The owner of this chat can connect one.</p>
      )}
    </div>
  );
}
