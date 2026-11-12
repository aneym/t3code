import {
  resolveProviderInstanceEnabled,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { CodexSetupSection } from "./CodexSetupSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { ProviderCliSetupSection } from "./ProviderCliSetupSection";
import { ProviderSetupSection, readAntigravityAuthMethod } from "./ProviderSetupSection";
import { SettingsRow } from "./settingsLayout";

function configuredBinaryPath(config: unknown): string {
  if (config === null || typeof config !== "object" || !("binaryPath" in config)) return "";
  return typeof config.binaryPath === "string" ? config.binaryPath.trim() : "";
}

export function providerInstanceSetup({
  environmentId,
  environmentLabel,
  instanceId,
  driver,
  instance,
  liveProvider,
  readOnly,
  onEnableInstance,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly instance: ProviderInstanceConfig;
  readonly liveProvider: ServerProvider | undefined;
  readonly readOnly: boolean;
  readonly onEnableInstance: (next: ProviderInstanceConfig) => void;
}): ReactNode {
  const codexSetupMode = driver === "codex" ? readCodexSetupMode(instance.config) : null;
  if (driver === "antigravity")
    return (
      <ProviderSetupSection
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={instanceId}
        provider={liveProvider}
        binaryPath={configuredBinaryPath(instance.config)}
        authMethod={readAntigravityAuthMethod(instance.config)}
        enabled={resolveProviderInstanceEnabled(instance)}
        readOnly={readOnly}
        onEnable={() => onEnableInstance({ ...instance, enabled: true })}
      />
    );
  if (codexSetupMode === "managed")
    return (
      <CodexSetupSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={liveProvider}
        mode={codexSetupMode}
        enabled={resolveProviderInstanceEnabled(instance)}
        readOnly={readOnly}
        onModeChange={(setupMode) =>
          onEnableInstance({
            ...instance,
            enabled: true,
            config: {
              ...(instance.config !== null && typeof instance.config === "object"
                ? instance.config
                : {}),
              enabled: true,
              setupMode,
            },
          })
        }
      />
    );
  if (
    liveProvider &&
    (driver === "claudeAgent" || driver === "codex") &&
    (liveProvider.setup?.canInstall || liveProvider.setup?.canAuthenticate)
  )
    return (
      <ProviderCliSetupSection
        key={`${environmentId}:${instanceId}`}
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={instanceId}
        provider={liveProvider}
      />
    );
  if (
    !readOnly &&
    liveProvider &&
    (liveProvider.setup?.canAuthenticate ||
      (liveProvider.driver === "acpRegistry" && liveProvider.installed))
  )
    return (
      <ProviderAuthenticationSection
        key={`${environmentId}:${instanceId}`}
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={instanceId}
        provider={liveProvider}
        readOnly={readOnly}
      />
    );
  if (!readOnly && driver === "cursor" && liveProvider?.setup?.canAuthenticate === false)
    return (
      <SettingsRow
        title="Cursor account"
        description="Using CURSOR_API_KEY. Remove it from this provider's environment to use browser sign-in."
      />
    );
  return null;
}
