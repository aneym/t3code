import { readOnOffSwitch } from "../onOffSwitch.ts";

export const SELF_UPDATE_ENV = "T3CODE_SELF_UPDATE";
export const selfUpdateSwitch = readOnOffSwitch(SELF_UPDATE_ENV);
export const selfUpdateOff = selfUpdateSwitch.off;
export const SELF_UPDATE_OFF_MESSAGE = `Updates are off for this install (${SELF_UPDATE_ENV}=off); the app that ships it updates it.`;
export const selfUpdateOffUnitLines = selfUpdateOff ? [`Environment=${SELF_UPDATE_ENV}=off`] : [];
export const selfUpdateOffPlistLines = selfUpdateOff
  ? [`    <key>${SELF_UPDATE_ENV}</key>`, `    <string>off</string>`]
  : [];
