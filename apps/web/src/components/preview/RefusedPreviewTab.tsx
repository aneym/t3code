import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { useEnvironmentSupportsServerBrowser } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { openPreviewSession } from "./openPreviewSession";

export function RefusedPreviewTab({
  threadRef,
  snapshot,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: PreviewSessionSnapshot;
}) {
  const serverBrowser = useEnvironmentSupportsServerBrowser(threadRef.environmentId);
  const open = useAtomCommand(previewEnvironment.open);
  const url = snapshot.navStatus._tag === "Idle" ? undefined : snapshot.navStatus.url;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="max-w-sm text-sm text-muted-foreground">
        This tab was opened or changed outside this desktop app, so it is not loaded here.
      </p>
      {url !== undefined && (
        <p className="max-w-sm truncate text-xs text-muted-foreground">{url}</p>
      )}
      {serverBrowser && (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void openPreviewSession({
              openPreview: open,
              threadRef,
              runtime: "server",
              ...(url === undefined ? {} : { url }),
            })
          }
        >
          Open in server browser
        </Button>
      )}
    </div>
  );
}
