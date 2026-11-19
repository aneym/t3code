import {
  CLOUD_SPEECH_LABELS,
  type CloudSpeechProvider,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useEnvironments } from "~/state/environments";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  type BrowserMicrophone,
  listAudioInputs,
  updateMicrophoneOrder,
} from "../../speech/browserMicrophones";
import { openMicrophone } from "../../speech/browserPcmCapture";
import {
  type MicrophoneEntry,
  isSystemDefaultDeviceId,
  microphoneEntryKey,
  microphoneOrder,
  preferMicrophone,
  preferredMicrophone,
  rememberMicrophones,
} from "../../speech/microphoneOrder";
import { chooseAudioDestination } from "../../speech/voiceConsent";
import {
  voiceDestinationChoices,
  voiceDestinationValue,
} from "../../speech/voiceDestinationChoices";
import { CloudVoiceConfiguration } from "../settings/CloudVoiceConfiguration";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerMenuProps } from "./composerEventScope";

const SYSTEM_DEFAULT: MicrophoneEntry = { kind: "default" };

function microphoneName(entry: MicrophoneEntry): string {
  return entry.kind === "default" ? "System default" : entry.label || "Saved microphone";
}

function microphoneChoices(
  order: ReadonlyArray<MicrophoneEntry>,
  devices: ReadonlyArray<BrowserMicrophone>,
): ReadonlyArray<MicrophoneEntry> {
  if (devices.every((device) => !device.deviceId || !device.label)) return order;
  return [
    SYSTEM_DEFAULT,
    ...devices
      .filter((device) => device.label && !isSystemDefaultDeviceId(device.deviceId))
      .map((device): MicrophoneEntry => ({ kind: "device", ...device })),
  ];
}

type Destination = {
  readonly environmentId: EnvironmentId | null;
  readonly cloudProvider?: CloudSpeechProvider;
};

export function ComposerMicrophonePicker(props: {
  disabled?: boolean | undefined;
  destination: Destination;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const menuProps = useComposerMenuProps();
  const { environments } = useEnvironments();
  const [pendingCloud, setPendingCloud] = useState<{
    provider: CloudSpeechProvider;
    environmentId: EnvironmentId;
  } | null>(null);
  const order = useClientSettings(microphoneOrder);
  const [devices, setDevices] = useState<BrowserMicrophone[]>([]);
  const refresh = useStableCallback(async () => {
    const next = await listAudioInputs().catch(() => []);
    setDevices(next);
    updateMicrophoneOrder((current) => rememberMicrophones(current, next));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows microphones plugged in or removed while the composer is open
  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    queueMicrotask(() => void refresh());
    const onChange = () => void refresh();
    mediaDevices.addEventListener("devicechange", onChange);
    return () => mediaDevices.removeEventListener("devicechange", onChange);
  }, [refresh]);
  const allowAccess = async () => {
    const stream = await openMicrophone("").catch(() => null);
    for (const track of stream?.getTracks() ?? []) track.stop();
    await refresh();
  };

  if (!navigator.mediaDevices?.enumerateDevices) return null;
  const current = preferredMicrophone(order, devices);
  const choices = microphoneChoices(order, devices);
  const needsAccess = devices.length > 0 && devices.every((device) => !device.label);
  const label = `Microphone: ${microphoneName(current)}`;
  const { environmentChoices, cloudChoices } = voiceDestinationChoices(environments);
  const destinations = [
    ...environmentChoices
      .filter(
        ({ environment }) =>
          environment.serverConfig?.environment.capabilities.voiceTranscription === true,
      )
      .map(({ environment, value }) => ({ value, label: environment.label })),
    ...cloudChoices.map(({ environment, provider, value }) => ({
      value,
      label: `${CLOUD_SPEECH_LABELS[provider]} via ${environment.label}`,
    })),
  ];
  const destinationValue = voiceDestinationValue(props.destination);
  const cloudEnvironment = environments.find(
    (environment) => environment.environmentId === pendingCloud?.environmentId,
  );

  return (
    <>
      <Menu
        open={props.open}
        onOpenChange={(open) => {
          props.onOpenChange(open);
          if (open) void refresh();
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                disabled={props.disabled}
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={label}
                    data-composer-microphone-picker=""
                    className="shrink-0"
                  />
                }
              />
            }
          >
            <ChevronDownIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="top" className="max-w-72" {...menuProps}>
          <MenuGroup>
            <MenuGroupLabel>
              {props.destination.environmentId ? "Transcribe with" : "Choose where to transcribe"}
            </MenuGroupLabel>
            {destinations.length > 0 ? (
              <MenuRadioGroup
                value={destinationValue}
                onValueChange={(value) => {
                  const cloud = cloudChoices.find((choice) => choice.value === value);
                  if (cloud) {
                    setPendingCloud({
                      environmentId: cloud.environment.environmentId,
                      provider: cloud.provider,
                    });
                    return;
                  }
                  const chosen = environmentChoices.find((choice) => choice.value === value);
                  if (chosen)
                    chooseAudioDestination({
                      kind: "environment",
                      environmentId: chosen.environment.environmentId,
                    });
                }}
              >
                {destinations.map((destination) => (
                  <MenuRadioItem key={destination.value} value={destination.value} closeOnClick>
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{destination.label}</span>
                      <MenuRadioItemIndicator />
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            ) : (
              <MenuItem disabled>Set up voice in T3 settings on a full T3 app</MenuItem>
            )}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Microphone</MenuGroupLabel>
            <MenuRadioGroup
              value={microphoneEntryKey(current)}
              onValueChange={(key) => {
                const entry = choices.find((choice) => microphoneEntryKey(choice) === key);
                if (entry) updateMicrophoneOrder((saved) => preferMicrophone(saved, entry));
              }}
            >
              {choices.map((entry) => (
                <MenuRadioItem
                  key={microphoneEntryKey(entry)}
                  value={microphoneEntryKey(entry)}
                  closeOnClick
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{microphoneName(entry)}</span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          {needsAccess ? (
            <>
              <MenuSeparator />
              <MenuItem closeOnClick={false} onClick={() => void allowAccess()}>
                Allow access to list microphones
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {pendingCloud && cloudEnvironment ? (
        <CloudVoiceConfiguration
          key={JSON.stringify(pendingCloud)}
          provider={pendingCloud.provider}
          environment={cloudEnvironment}
          active={
            props.destination.environmentId === pendingCloud.environmentId &&
            props.destination.cloudProvider === pendingCloud.provider
          }
          close={() => setPendingCloud(null)}
        />
      ) : null}
    </>
  );
}
