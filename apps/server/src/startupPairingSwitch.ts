import { readOnOffSwitch } from "./onOffSwitch.ts";

export const startupPairingSwitch = readOnOffSwitch("T3CODE_STARTUP_PAIRING");
export const startupPairingOff = startupPairingSwitch.off;
