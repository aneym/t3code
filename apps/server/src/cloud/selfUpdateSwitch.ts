export const SELF_UPDATE_ENV = "T3CODE_SELF_UPDATE";
const selfUpdateSetting = process.env[SELF_UPDATE_ENV]?.trim().toLowerCase() || undefined;
if (selfUpdateSetting !== undefined && selfUpdateSetting !== "on" && selfUpdateSetting !== "off") {
  throw new Error(`${SELF_UPDATE_ENV} must be on or off.`);
}
export const selfUpdateOff = selfUpdateSetting === "off";
export const SELF_UPDATE_OFF_MESSAGE = `Updates are off for this install (${SELF_UPDATE_ENV}=off); the app that ships it updates it.`;
export const selfUpdateOffUnitLines = selfUpdateOff ? [`Environment=${SELF_UPDATE_ENV}=off`] : [];
export const selfUpdateOffPlistLines = selfUpdateOff
  ? [`    <key>${SELF_UPDATE_ENV}</key>`, `    <string>off</string>`]
  : [];
