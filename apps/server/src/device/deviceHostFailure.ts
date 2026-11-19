import { SshCommandError } from "@t3tools/ssh/errors";
import * as Schema from "effect/Schema";

import type * as DeviceHost from "./DeviceHost.ts";
import { DeviceToolchainInstallError } from "./DeviceToolchain.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";

const isSshCommandError = Schema.is(SshCommandError);

export const sshProbeFailureMessage = (error: DeviceHost.DeviceHostError): string => {
  const windows = SshDeviceHost.isSshWindowsHostError(error.cause) ? error.cause : null;
  const cause = windows ? windows.cause : error.cause;
  if (
    !isSshCommandError(cause) ||
    cause.exitCode === null ||
    cause.exitCode < 1 ||
    (cause.exitCode > 254 && cause.exitCode !== 9009)
  )
    return "Could not connect to this host over SSH.";

  if (
    cause.exitCode === 1 &&
    cause.stderr
      .split(/\r?\n/u)
      .some((line) => line.trim() === "Node is missing from the non-interactive SSH PATH")
  )
    return "Connected over SSH, but Node is not on this host's PATH for non-interactive SSH commands.";
  if (windows) return windows.message;

  return `Connected over SSH, but the device host check failed (exit code ${cause.exitCode}).`;
};

const isToolchainInstallError = Schema.is(DeviceToolchainInstallError);

export const actionableHostFailure = (error: DeviceHost.DeviceHostError): string | undefined => {
  if (error.step === "probe") return sshProbeFailureMessage(error);
  if (isToolchainInstallError(error.cause) && error.cause.reason === "npm_not_found")
    return error.cause.message;
  return undefined;
};
