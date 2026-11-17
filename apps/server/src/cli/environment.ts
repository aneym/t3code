import {
  AuthMcpClientAccess,
  PeerLink,
  PeerLinkListResult,
  PeerLinkRemoveResult,
  type PeerLinkSummary,
  peerLinkRenewalState,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";

import { authLocationFlags } from "./config.ts";
import { environmentShowCommand } from "./environmentShow.ts";
import {
  McpServerNotRunningError,
  McpServerUnreachableError,
  McpToolFailedError,
  reportCliErrors,
  withOwnerMcpTools,
} from "./ownerMcpTools.ts";

const reportErrors = reportCliErrors(
  Schema.is(
    Schema.Union([McpServerNotRunningError, McpServerUnreachableError, McpToolFailedError]),
  ),
);

const PeerLinkJson = Schema.toCodecJson(PeerLink);
const PeerLinkListJson = Schema.toCodecJson(PeerLinkListResult);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeLinks = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.toEncoded(Schema.Unknown))),
);

const formatRenewal = (link: PeerLinkSummary, nowMs: number) =>
  `renewal ${peerLinkRenewalState(link, nowMs)}${link.renewedAt === undefined ? "" : `, renewed ${DateTime.formatIso(link.renewedAt)}`}${link.renewalError === undefined ? "" : `\n  renewal refused: ${link.renewalError}`}`;

const formatLinks = (links: ReadonlyArray<PeerLinkSummary>, nowMs: number) =>
  links.length === 0
    ? "No linked environments.\n"
    : `${links
        .map(
          (link) =>
            `${link.label} (${link.environmentId})\n  ${link.status}, access ${link.access}, expires ${DateTime.formatIso(link.expiresAt)}, ${formatRenewal(link, nowMs)}\n  ${link.urls.join(", ")}${link.lastError === null ? "" : `\n  last error: ${link.lastError}`}`,
        )
        .join("\n\n")}\n`;

const environmentLinkCommand = Command.make("link", {
  ...authLocationFlags,
  url: Argument.String("url").pipe(
    Argument.withDescription(
      "Where the other environment answers: its T3 Connect, Tailscale, LAN or loopback address.",
    ),
  ),
  alternateUrl: Flag.String("url").pipe(
    Flag.withDescription("Another address for the same environment, tried after the first."),
    Flag.atLeast(0),
  ),
  pairingCode: Flag.String("pairing-code").pipe(
    Flag.withDescription("A pairing code from the other environment (`t3 pair` there)."),
  ),
  access: Flag.Literals("access", AuthMcpClientAccess.literals).pipe(
    Flag.withDescription(
      "What this environment's agents may do there: read-only, or the broadest runtime mode.",
    ),
    Flag.withDefault("approval-required" as const),
  ),
}).pipe(
  Command.withDescription(
    "Link another T3 Code environment, so agents here can work there. It shows up there under Settings → Connections, where it can be revoked.",
  ),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "environment",
      flags,
      Effect.fn("cli.environment.link")(function* (tools) {
        const linked = yield* tools.call(
          "t3_peer_link_create",
          {
            url: flags.url,
            alternateUrls: flags.alternateUrl,
            pairingCode: flags.pairingCode,
            access: flags.access,
          },
          PeerLinkJson,
        );
        yield* Console.log(
          `Linked ${linked.label} (${linked.environmentId}) with ${linked.access} access, until ${DateTime.formatIso(linked.expiresAt)}.\n`,
        );
      }),
    ).pipe(reportErrors),
  ),
);

const environmentListCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List linked environments and whether each answers now."),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "environment",
      { ...flags, quietLogs: flags.json },
      Effect.fn("cli.environment.list")(function* (tools) {
        const { links } = yield* tools.call("t3_peer_link_list", {}, PeerLinkListJson);
        const now = yield* DateTime.now;
        yield* Console.log(
          flags.json ? `${yield* encodeLinks(links)}\n` : formatLinks(links, now.epochMilliseconds),
        );
      }),
    ).pipe(reportErrors),
  ),
);

const environmentUnlinkCommand = Command.make("unlink", {
  ...authLocationFlags,
  environmentId: Argument.String("environment-id").pipe(
    Argument.withDescription("The linked environment's id, from `t3 environment list`."),
  ),
}).pipe(
  Command.withDescription(
    "Forget a linked environment here. Revoke it in that environment's Connections to end its session there too.",
  ),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "environment",
      flags,
      Effect.fn("cli.environment.unlink")(function* (tools) {
        const { removed } = yield* tools.call(
          "t3_peer_link_unlink",
          { environmentId: flags.environmentId },
          PeerLinkRemoveResult,
        );
        yield* Console.log(
          removed
            ? `Forgot ${flags.environmentId}. Revoke it in that environment's Connections to end its session there.\n`
            : `No linked environment ${flags.environmentId}.\n`,
        );
      }),
    ).pipe(reportErrors),
  ),
);

const environmentRenewCommand = Command.make("renew", {
  ...authLocationFlags,
  environmentId: Argument.String("environment-id").pipe(
    Argument.withDescription("The linked environment's id, from `t3 environment list`."),
  ),
}).pipe(
  Command.withDescription(
    "Renew a link for 30 more days without a pairing code. Works only in its last 7 days, and only when the other environment allows renewal. Links renew on their own while the server runs.",
  ),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "environment",
      flags,
      Effect.fn("cli.environment.renew")(function* (tools) {
        const renewed = yield* tools.call(
          "t3_peer_link_renew",
          { environmentId: flags.environmentId },
          PeerLinkJson,
        );
        yield* Console.log(
          `Renewed ${renewed.label} (${renewed.environmentId}) until ${DateTime.formatIso(renewed.expiresAt)}.\n`,
        );
      }),
    ).pipe(reportErrors),
  ),
);

export const environmentCommand = Command.make("environment").pipe(
  Command.withDescription("Link other T3 Code environments, so agents here can work there."),
  Command.withSubcommands([
    environmentShowCommand,
    environmentLinkCommand,
    environmentListCommand,
    environmentUnlinkCommand,
    environmentRenewCommand,
  ]),
);
