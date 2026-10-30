import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

// An instantly failing relay client otherwise respawns ~100 times/sec and exhausts V8 via tracing.
export const RELAY_RESTART_STABLE_UPTIME_MS = 30_000;
export const RELAY_RESTART_BACKOFF_BASE_MS = 1_000;
export const RELAY_RESTART_BACKOFF_MAX_MS = 60_000;
// Newly created tunnels can fail authorization briefly while Cloudflare propagates their token.
export const TUNNEL_AUTHORIZATION_FAILURES_BEFORE_RECOVERY = 4;
// Unknown rejection wording can leave a dead tunnel unconnected; periodically request recovery.
export const CONNECTOR_REGISTRATION_TIMEOUT = Duration.minutes(3);
// cloudflared resolves edges only at startup and can keep dialing stale addresses after a network change.
export const CONNECTOR_READINESS_INTERVAL = Duration.seconds(30);
export const CONNECTOR_READINESS_REQUEST_TIMEOUT = Duration.seconds(5);
export const CONNECTOR_NOT_READY_CHECKS_BEFORE_RESTART = 6;
export const CONNECTOR_NOT_READY_CHECKS_MAX = 60;
export const RELAY_CLIENT_METRICS_LINE =
  /\bStarting metrics server on (127\.0\.0\.1:\d+)\/metrics\b/u;
export const RELAY_CLIENT_PROTOCOL = /\bprotocol=(\w+)/u;
// cloudflared's metrics server: `/ready` answers 200 or 503 with this body, and
// `/config` holds the ingress rules the edge pushed after the first connection.
export const ConnectorReadyBody = Schema.Struct({ readyConnections: Schema.Number });
export const ConnectorConfigBody = Schema.Struct({
  config: Schema.Struct({
    ingress: Schema.optional(
      Schema.NullOr(Schema.Array(Schema.Struct({ hostname: Schema.optional(Schema.String) }))),
    ),
  }),
});
// Registration resets cloudflared's own fallback, even when QUIC stalls again
// immediately. Keep that evidence across registrations and connector restarts.
export const QUIC_STALLS_BEFORE_HTTP2 = 30;
export const QUIC_STALL_WINDOW_MS = 5 * 60_000;
// A failed background install of the pinned relay client is retried no sooner
// than this, so a crash-looping connector or an offline host does not redownload
// on every reconcile.
export const RELAY_CLIENT_INSTALL_RETRY_INTERVAL_MS = 10 * 60_000;

/** Preserve user-chosen PATH binaries and overrides; CLI downloads require consent. */
export function needsPinnedRelayClient(executable: RelayClient.RelayClientStatus): boolean {
  return (
    executable.status === "missing" ||
    (executable.status === "available" &&
      executable.source === "managed" &&
      !RelayClient.isPinnedManagedRelayClient(executable))
  );
}

export function classifyRelayClientOutput(line: string): "connected" | "warning" | "debug" {
  if (/\bRegistered tunnel connection\b/iu.test(line)) {
    return "connected";
  }
  // cloudflared uses zerolog FTL/PNC for fatal/panic; classify them above debug too.
  return /\b(?:ERR|WRN|FTL|PNC)\b/u.test(line) ? "warning" : "debug";
}

/** Edge rejection wording varies; any Unauthorized registration error counts. */
export function isRejectedRelayClientTunnelOutput(line: string): boolean {
  return (
    /\bRegister tunnel error from server side\b/iu.test(line) &&
    /error="(?:Unauthorized:[^"]*|Failed to get tunnel|Tunnel not found|Record for tunnel not found|Invalid tunnel secret)"/iu.test(
      line,
    )
  );
}

export function runtimeConfigKey(config: RelayManagedEndpointRuntimeConfig): string {
  return JSON.stringify({
    providerKind: config.providerKind,
    connectorToken: config.connectorToken,
    tunnelId: config.tunnelId ?? null,
    tunnelName: config.tunnelName ?? null,
  });
}
