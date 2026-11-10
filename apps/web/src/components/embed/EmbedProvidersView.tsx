import { EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";

import { ProviderSettingsPanel } from "../settings/ProviderSettingsPanel";
import { Button } from "../ui/button";

export function EmbedProvidersView({
  environmentId,
  returnThreadId,
  instanceId,
}: {
  readonly environmentId: string;
  readonly returnThreadId: string | null;
  readonly instanceId: ProviderInstanceId | null;
}) {
  const navigate = useNavigate();
  return (
    <main className="flex h-dvh min-w-0 flex-1 flex-col bg-background">
      {returnThreadId === null ? null : (
        <div className="flex shrink-0 items-center px-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void navigate({
                to: "/embed/$environmentId/$threadId",
                params: { environmentId, threadId: returnThreadId },
              })
            }
          >
            <ChevronLeftIcon />
            Back to chat
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ProviderSettingsPanel
          environmentId={EnvironmentId.make(environmentId)}
          {...(instanceId === null ? {} : { instanceId })}
          scoped
        />
      </div>
    </main>
  );
}
