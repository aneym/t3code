import {
  AuthPreviewOperateScope,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { useAtomValue } from "@effect/atom-react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { admitsDesktopTab, usePreviewAvailable } from "~/browser/previewRuntime";
import { isElectron } from "~/env";
import { useThreadPreviewState } from "~/previewStateStore";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useEnvironmentScope } from "~/state/session";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";
import { RefusedPreviewTab } from "./RefusedPreviewTab";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

export function PreviewPanel({
  mode,
  threadRef,
  tabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const available = usePreviewAvailable(threadRef.environmentId);
  const canOperatePreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const previewState = useThreadPreviewState(threadRef);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const shownTabId = tabId ?? previewState.activeTabId;
  const snapshot = shownTabId ? previewState.sessions[shownTabId] : undefined;
  const refusedSnapshot =
    isElectron &&
    snapshot !== undefined &&
    snapshot.runtime !== "server" &&
    !admitsDesktopTab(threadRef, snapshot, primaryEnvironmentId)
      ? snapshot
      : null;
  if (!canOperatePreview || !available) {
    return (
      <PreviewPanelShell mode={mode}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {canOperatePreview
              ? "Preview is only available in the T3 Code desktop app."
              : "Pair this client again with preview access to control browser previews."}
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      {refusedSnapshot ? (
        <RefusedPreviewTab threadRef={threadRef} snapshot={refusedSnapshot} />
      ) : (
        <PreviewView
          threadRef={threadRef}
          {...(tabId !== undefined ? { tabId } : {})}
          configuredUrls={configuredUrls}
          visible={visible}
          {...(onSendAnnotation ? { onSendAnnotation } : {})}
        />
      )}
    </PreviewPanelShell>
  );
}
