import { useState } from "react";

import { Input } from "../ui/input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function parseOrigins(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function AllowedOriginsInput({ saved }: { readonly saved: ReadonlyArray<string> }) {
  const updateSettings = useUpdateScopedSettings();
  const savedText = saved.join(" ");
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== savedText) updateSettings({ embedAllowedOrigins: parseOrigins(draft) });
  };
  return (
    <Input
      size="sm"
      className="w-72"
      aria-label="Pages that may show the bare chat"
      placeholder="https://app.example.com"
      value={draft ?? savedText}
      onValueChange={setDraft}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

export function EmbedModeSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        serverScoped
        title="Bare chat for host apps"
        settingKeys={["embedModeEnabled"]}
        description="Let another app show one thread at /embed/<environment>/<thread>, with no sidebar, header or panel buttons. The app sends the chat's colors, and gets its links and reserved shortcuts back as messages."
        control={
          <ScopedSwitch
            settingKeys={["embedModeEnabled"]}
            checked={settings.embedModeEnabled}
            onCheckedChange={(checked) => updateSettings({ embedModeEnabled: Boolean(checked) })}
            aria-label="Bare chat for host apps"
          />
        }
      />
      {settings.embedModeEnabled ? (
        <SettingsRow
          serverScoped
          title="Pages that may show the bare chat"
          settingKeys={["embedAllowedOrigins"]}
          description="Web page origins allowed to frame it, separated by spaces. A desktop app that loads the page directly needs none."
          control={<AllowedOriginsInput saved={settings.embedAllowedOrigins} />}
        />
      ) : null}
    </>
  );
}
