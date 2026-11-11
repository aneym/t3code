export interface OnOffSwitch {
  readonly name: string;
  readonly off: boolean;
  readonly invalidValue: string | undefined;
}

export const readOnOffSwitch = (name: string): OnOffSwitch => {
  const raw = process.env[name]?.trim() ?? "";
  const setting = raw.toLowerCase();
  return {
    name,
    off: setting === "off",
    invalidValue: setting === "" || setting === "on" || setting === "off" ? undefined : raw,
  };
};

export const onOffSwitchRefusal = (onOff: OnOffSwitch): string | undefined =>
  onOff.invalidValue === undefined
    ? undefined
    : `${onOff.name} is "${onOff.invalidValue}"; use on or off.`;
