import { providerInstanceEntriesFor } from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Switch } from "../ui/switch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function DelegatedChildModelSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, target } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    target?.projectId ?? null,
  );
  const setting = settings.delegatedChildModel;
  const fallback = resolveAppModelSelectionState(settings, providers);
  const instanceId = setting?.providerInstanceId ?? fallback.instanceId;
  const model = setting?.model ?? fallback.model;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["delegatedChildModel"]}
      {...searchableSetting("delegated-child-model")}
      description="Model a delegated child gets when its task names no model and it runs on this model's provider. Off, a child takes its parent's model."
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {setting === null ? null : (
            <ProviderModelPicker
              environmentId={environment?.environmentId ?? null}
              activeInstanceId={instanceId}
              model={model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={getCustomModelOptionsByInstance(
                settings,
                providers,
                instanceId,
                model,
              )}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Delegated child model"
              onInstanceModelChange={(nextInstanceId, nextModel) =>
                updateSettings({
                  delegatedChildModel: { providerInstanceId: nextInstanceId, model: nextModel },
                })
              }
            />
          )}
          <Switch
            checked={setting !== null}
            disabled={setting === null && instanceEntries.length === 0}
            onCheckedChange={(checked) =>
              updateSettings({
                delegatedChildModel: checked
                  ? { providerInstanceId: fallback.instanceId, model: fallback.model }
                  : null,
              })
            }
            aria-label="Delegated child model"
          />
        </div>
      }
    />
  );
}
