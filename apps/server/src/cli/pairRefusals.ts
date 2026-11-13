import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import { cliRefusal } from "../cliRefusal.ts";

export class NoRunningServerError extends Schema.TaggedError<NoRunningServerError>()(
  "NoRunningServerError",
  {
    checkedStatePaths: Schema.Array(Schema.String),
    inLinkedWorktree: Schema.Boolean,
    serveCommand: Schema.String,
    connectCommand: Schema.String,
  },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return [
      "No running T3 Code server found.",
      ...this.checkedStatePaths.map((statePath) => `  checked ${statePath}`),
      ...(this.inLinkedWorktree
        ? ["In a linked worktree, pass --base-dir to pair with a server outside it."]
        : []),
      `Start one with \`${this.serveCommand}\`, or connect this machine with T3 Connect: \`${this.connectCommand}\`.`,
    ].join("\n");
  }
}

export class IncompatibleServerProtocolError extends Schema.TaggedError<IncompatibleServerProtocolError>()(
  "IncompatibleServerProtocolError",
  {
    serverVersion: Schema.String,
    serverProtocolVersion: Schema.Number,
    pairCommand: Schema.String,
  },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return [
      `The running T3 Code server (${this.serverVersion}) speaks orchestration protocol ${String(this.serverProtocolVersion)}, but this CLI speaks protocol ${String(ORCHESTRATION_PROTOCOL_VERSION)}.`,
      `Pair with the matching CLI instead: \`${this.pairCommand}\`.`,
    ].join("\n");
  }
}

export class TailscaleUnavailableError extends Schema.TaggedError<TailscaleUnavailableError>()(
  "TailscaleUnavailableError",
  { cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return "Could not talk to Tailscale. Is tailscaled running? Try `tailscale status`.";
  }
}

export class MagicDnsNameMissingError extends Schema.TaggedError<MagicDnsNameMissingError>()(
  "MagicDnsNameMissingError",
  {},
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return "This machine has no MagicDNS name. Run `tailscale up` and enable MagicDNS.";
  }
}

export class TailscaleServeNotEnabledError extends Schema.TaggedError<TailscaleServeNotEnabledError>()(
  "TailscaleServeNotEnabledError",
  {},
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return "Tailscale Serve is not enabled on your tailnet. Enable HTTPS certificates at https://login.tailscale.com/admin/dns, then run this command again.";
  }
}

export class ServesOtherEnvironmentError extends Schema.TaggedError<ServesOtherEnvironmentError>()(
  "ServesOtherEnvironmentError",
  { servePort: Schema.Number },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return `Tailscale Serve on HTTPS port ${String(this.servePort)} already fronts a different T3 Code server. Pass --tailscale-serve-port to publish this one on another port.`;
  }
}

export class TailscaleServeFailedError extends Schema.TaggedError<TailscaleServeFailedError>()(
  "TailscaleServeFailedError",
  { servePort: Schema.Number, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return `tailscale serve failed for HTTPS port ${String(this.servePort)}. Run \`tailscale serve --https=${String(this.servePort)} --bg <local-url>\` by hand to see why.`;
  }
}

export class TailscaleServeTargetRefusedError extends Schema.TaggedError<TailscaleServeTargetRefusedError>()(
  "TailscaleServeTargetRefusedError",
  { localHost: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return `This Tailscale install can only proxy to localhost, and the server listens on ${this.localHost}. Restart it with \`--host 127.0.0.1\` or \`--host 0.0.0.0\`, then run this command again.`;
  }
}

export class ServePortOccupiedError extends Schema.TaggedError<ServePortOccupiedError>()(
  "ServePortOccupiedError",
  { servePort: Schema.Number },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return `HTTPS port ${String(this.servePort)} on the tailnet already serves something that is not a T3 Code server. Pass --tailscale-serve-port to publish this one on another port.`;
  }
}

export class DevServerNotProxiableError extends Schema.TaggedError<DevServerNotProxiableError>()(
  "DevServerNotProxiableError",
  { devUrl: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return `Tailscale Serve can only proxy plain-HTTP local targets, and this dev server runs at ${this.devUrl}. Pair without --tailscale instead.`;
  }
}
