import type { DesktopRailsWordsNotice, DesktopRailsWordsState } from "@t3tools/contracts";
import { useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { disconnectRailsWords, useRailsWordsState } from "../../railsWords/railsWordsState";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

const NOTICE_TEXT: Record<DesktopRailsWordsNotice, string> = {
  "removed-in-rails": "This device was removed in Rails. Connect again from Rails settings.",
  disconnected: "Disconnected. Rails removed this device too.",
  "disconnected-here":
    "Disconnected here, but Rails couldn't be told. Remove this device in Rails Settings > Computers.",
  "connect-refused": "Rails refused the connection. Start again from Rails settings.",
  "connect-failed": "Couldn't reach Rails. Click Connect in Rails settings again.",
  "connect-full": "Rails already has 20 computers connected. Remove one there, then connect again.",
  "storage-unavailable": "This computer has no secure key storage, so it can't connect to Rails.",
};

function describe(state: DesktopRailsWordsState | null, enabled: boolean): string {
  if (!enabled) return "Off. Nothing you type leaves this app.";
  if (state === null || !state.connected) return "Not connected. Connect from Rails settings.";
  const since = state.connectedAt
    ? ` since ${new Date(state.connectedAt).toLocaleDateString()}`
    : "";
  const status = state.unreachableSince
    ? "Rails unreachable."
    : state.lastSentAt
      ? `Last sent ${formatRelativeTimeLabel(state.lastSentAt)}.`
      : "Nothing sent yet.";
  const rails = state.personName ? `${state.personName}'s Rails` : "Rails";
  return `Connected to ${rails} as ${state.deviceName ?? "this device"}${since}. ${status}`;
}

export function RailsConnectionRow() {
  const enabled = useClientSettings((settings) => settings.railsWordsEnabled);
  const state = useRailsWordsState();
  const [disconnecting, setDisconnecting] = useState(false);
  if (!window.desktopBridge?.railsWords) return null;

  const disconnect = () => {
    setDisconnecting(true);
    void disconnectRailsWords().finally(() => setDisconnecting(false));
  };

  return (
    <SettingsRow
      title="Send typed words to Rails"
      description={
        <>
          {describe(state, enabled)}
          {state?.notice ? <span className="block">{NOTICE_TEXT[state.notice]}</span> : null}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          {state?.connected ? (
            <Button variant="outline" size="compact" disabled={disconnecting} onClick={disconnect}>
              Disconnect
            </Button>
          ) : null}
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => void updateClientSettings({ railsWordsEnabled: checked })}
            aria-label="Send typed words to Rails"
          />
        </div>
      }
    />
  );
}
