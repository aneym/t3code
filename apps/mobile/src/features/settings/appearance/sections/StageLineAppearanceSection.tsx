import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

export function StageLineAppearanceSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const hideTrailingStageLine =
    AsyncResult.isSuccess(preferences) && preferences.value.hideTrailingStageLine !== false;

  return (
    <View className="gap-3">
      <SettingsSection title="Agent replies">
        <SettingsSwitchRow
          icon="eye.slash"
          label="Hide stage lines"
          value={hideTrailingStageLine}
          onValueChange={(value) => savePreferences({ hideTrailingStageLine: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Hide the last line of an agent reply when it is a stage line like Done · or Working ·. Copy
        still includes it.
      </Text>
    </View>
  );
}
