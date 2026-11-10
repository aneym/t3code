const STARTUP_PAIRING_ENV = "T3CODE_STARTUP_PAIRING";
const startupPairingSetting = process.env[STARTUP_PAIRING_ENV]?.trim().toLowerCase() || undefined;
if (
  startupPairingSetting !== undefined &&
  startupPairingSetting !== "on" &&
  startupPairingSetting !== "off"
) {
  throw new Error(`${STARTUP_PAIRING_ENV} must be on or off.`);
}
export const startupPairingOff = startupPairingSetting === "off";
