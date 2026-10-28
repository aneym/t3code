import { useEffect, useEffectEvent } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import {
  AuthOrchestrationOperateScope,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";
import type { useServerConfigs } from "../../state/entities";
import type { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { readEnvironmentScope } from "../../state/session";
import type { AsyncResult } from "effect/reactivity";
import type { Preferences } from "../../persistence/mobile-preferences";
import {
  composerContextImportsAtom,
  getComposerDraftSnapshot,
  updateComposerDraftRouting,
  updateComposerDraftSettings,
  type ComposerDraft,
} from "../../state/use-composer-drafts";
import { appAtomRegistry } from "../../state/atom-registry";
import { buildModelOptions } from "../../lib/modelOptions";
import * as Dialog from "../../components/ui/Dialog";
import { resolveEnvironmentProjectMatch } from "./new-task-project-selection";
import { useLoadBalancedEnvironment } from "./use-load-balanced-environment";

export function useAutoEnvironmentRouting(input: {
  readonly draftKey: string | null;
  readonly draft: ComposerDraft;
  readonly selectedProject: EnvironmentProject | null;
  readonly selectedModel: ModelSelection | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly projects: readonly EnvironmentProject[];
  readonly serverConfigs: ReturnType<typeof useServerConfigs>;
  readonly connectedEnvironments: ReturnType<
    typeof useRemoteConnectionStatus
  >["connectedEnvironments"];
  readonly preferences: AsyncResult.AsyncResult<Preferences, unknown>;
  readonly isScratchDraft: boolean;
  readonly locked: boolean;
  readonly onResolved: (project: EnvironmentProject) => void;
}) {
  const contextImports = useAtomValue(composerContextImportsAtom);
  const importing = input.draftKey !== null && contextImports[input.draftKey] === true;
  const preferences = input.preferences._tag === "Success" ? input.preferences.value : null;
  const weights = preferences?.loadBalancingWeights ?? {};
  const candidates = input.connectedEnvironments.flatMap((environment) => {
    if (!environment.isEnabled || environment.connectionState !== "connected") return [];
    const project = resolveEnvironmentProjectMatch(
      input.projects.filter((project) => project.environmentId === environment.environmentId),
      input.selectedProject,
      false,
    );
    const config = input.serverConfigs.get(environment.environmentId);
    const provider = config?.providers.find(
      (provider) => provider.instanceId === input.selectedModel?.instanceId,
    );
    if (
      !project ||
      !config?.settings ||
      !provider ||
      !input.selectedModel ||
      provider.driver !== input.selectedProviderStatus?.driver ||
      !resolveProjectProviderInstanceEnabled(config.settings, project.id, provider.instanceId) ||
      !provider.installed ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable" ||
      (weights[environment.environmentId] ?? 50) <= 0 ||
      !readEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope) ||
      threadContextsOutsideEnvironment({
        text: input.draft.text,
        records: input.draft.context?.records ?? [],
        environmentId: environment.environmentId,
        linkedEnvironments: new Map(),
      }).length > 0 ||
      !buildModelOptions(config, input.selectedModel, undefined, project.id).some(
        (option) =>
          option.selection.instanceId === input.selectedModel?.instanceId &&
          option.selection.model === input.selectedModel?.model &&
          !option.isUnavailable,
      )
    )
      return [];
    return [project];
  });
  const environmentSelection = input.draft.environmentSelection ?? "manual";
  const loadBalancedEnvironmentId = input.draft.loadBalancedEnvironmentId ?? null;
  const autoBalanceUnresolved =
    environmentSelection === "auto" && loadBalancedEnvironmentId === null;
  const pinned = input.draft.workspaceSelection !== undefined;
  const canAutoBalance =
    preferences?.loadBalancingEnabled === true &&
    !input.isScratchDraft &&
    input.selectedProject !== null &&
    !pinned &&
    candidates.length >= 2;
  const enabled =
    autoBalanceUnresolved &&
    !input.locked &&
    preferences?.loadBalancingEnabled === true &&
    !input.isScratchDraft &&
    !pinned &&
    input.draft.attachments.length === 0;
  const resources = useLoadBalancedEnvironment(
    candidates.map((project) => project.environmentId),
    weights,
    enabled,
  );
  const resolveTarget = useEffectEvent((environmentId: EnvironmentId | null) => {
    if (!environmentId || !input.draftKey || !enabled) return;
    const draft = getComposerDraftSnapshot(input.draftKey);
    if (
      draft.environmentSelection !== "auto" ||
      draft.loadBalancedEnvironmentId ||
      draft.attachments.length > 0 ||
      draft.workspaceSelection ||
      appAtomRegistry.get(composerContextImportsAtom)[input.draftKey]
    )
      return;
    const project = candidates.find((project) => project.environmentId === environmentId);
    if (!project || !input.selectedModel) return;
    updateComposerDraftSettings(input.draftKey, { modelSelection: input.selectedModel });
    updateComposerDraftRouting(input.draftKey, {
      mode: "auto",
      project: { environmentId, projectId: project.id },
    });
    input.onResolved(project);
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Commits an asynchronously received host snapshot to the persisted draft routing state.
  useEffect(() => {
    if (!resources.pending && !importing) resolveTarget(resources.environmentId);
  }, [resources.pending, resources.environmentId, importing]);
  const selectAutoEnvironment = () => {
    if (
      !input.draftKey ||
      input.locked ||
      !canAutoBalance ||
      !input.selectedModel ||
      appAtomRegistry.get(composerContextImportsAtom)[input.draftKey]
    )
      return false;
    if (getComposerDraftSnapshot(input.draftKey).attachments.length > 0) {
      Dialog.alert(
        "Keep attachments on this machine",
        "Remove attachments before choosing Auto balance.",
      );
      return false;
    }
    updateComposerDraftSettings(input.draftKey, { modelSelection: input.selectedModel });
    updateComposerDraftRouting(input.draftKey, { mode: "auto" });
    resources.refresh(candidates.map((project) => project.environmentId));
    return true;
  };
  return {
    environmentSelection,
    loadBalancedEnvironmentId,
    autoBalanceUnresolved,
    canAutoBalance,
    selectAutoEnvironment,
    autoBalanceLabel: autoBalanceUnresolved
      ? enabled && resources.pending
        ? "Checking machines…"
        : "Auto balance unavailable"
      : "Auto balance",
  };
}
