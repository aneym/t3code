import {
  AuthSessionId,
  AuthStandardClientScopes,
  ServerAuthIssuedSession,
  ServerAuthPairingLink,
  ServerAuthPairingList,
  ServerAuthSessionList,
  ServerAuthSessionRevokeResult,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "../cliAuthFormat.ts";
import { authScopesFlag } from "./authScopes.ts";
import { authLocationFlags, DurationFromString } from "./config.ts";
import {
  McpServerNotRunningError,
  McpServerUnreachableError,
  McpToolFailedError,
  reportCliErrors,
  withOwnerMcpTools,
} from "./ownerMcpTools.ts";

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withSchema(
    Schema.URLFromString.pipe(
      Schema.check(
        Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:", {
          expected: "an http:// or https:// URL",
        }),
      ),
    ),
  ),
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const chatThreadFlag = Flag.String("chat-thread").pipe(
  Flag.withDescription(
    "Thread id for a chat-only session. Repeat for each thread; replaces --scope with chat:threads.",
  ),
  Flag.atLeast(0),
);

const chatOwnerThreadFlag = Flag.String("chat-owner-thread").pipe(
  Flag.withDescription(
    "Thread id the chat session may set model, effort and access on. Repeat; each is also a --chat-thread.",
  ),
  Flag.atLeast(0),
);

const tokenOnlyFlag = Flag.Boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const reportSessionErrors = reportCliErrors(
  Schema.is(
    Schema.Union([McpServerNotRunningError, McpServerUnreachableError, McpToolFailedError]),
  ),
);

const ttlArgument = (ttl: Option.Option<Duration.Duration>) =>
  Option.match(ttl, {
    onNone: () => ({}),
    onSome: (value) => ({ ttlMs: Math.max(1, Math.round(Duration.toMillis(value))) }),
  });

const PairingLinkJson = Schema.toCodecJson(ServerAuthPairingLink);
const PairingListJson = Schema.toCodecJson(ServerAuthPairingList);

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  chatThreads: chatThreadFlag,
  chatOwnerThreads: chatOwnerThreadFlag,
  ttl: ttlFlag,
  label: labelFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Have the running server issue a new client pairing token."),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "auth",
      { ...flags, quietLogs: flags.json },
      Effect.fn("cli.auth.pairing.create")(function* (tools) {
        const issued = yield* tools.call(
          "t3_auth_pairing_create",
          {
            scopes: flags.scopes,
            ...(flags.chatThreads.length + flags.chatOwnerThreads.length > 0
              ? { chatThreadIds: [...new Set([...flags.chatThreads, ...flags.chatOwnerThreads])] }
              : {}),
            ...(flags.chatOwnerThreads.length > 0
              ? { chatOwnerThreadIds: flags.chatOwnerThreads }
              : {}),
            ...ttlArgument(flags.ttl),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          },
          PairingLinkJson,
        );
        yield* Console.log(
          formatIssuedPairingCredential(issued, {
            json: flags.json,
            ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value.href } : {}),
          }),
        );
      }),
    ).pipe(reportSessionErrors),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List the running server's active client pairing tokens without revealing their secrets.",
  ),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "auth",
      { ...flags, quietLogs: flags.json },
      Effect.fn("cli.auth.pairing.list")(function* (tools) {
        const { pairingLinks } = yield* tools.call("t3_auth_pairing_list", {}, PairingListJson);
        yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
      }),
    ).pipe(reportSessionErrors),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Have the running server revoke an active client pairing token."),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "auth",
      flags,
      Effect.fn("cli.auth.pairing.revoke")(function* (tools) {
        const { revoked } = yield* tools.call(
          "t3_auth_pairing_revoke",
          { id: flags.id },
          ServerAuthSessionRevokeResult,
        );
        yield* Console.log(
          revoked
            ? `Revoked pairing credential ${flags.id}.\n`
            : `No active pairing credential found for ${flags.id}.\n`,
        );
      }),
    ).pipe(reportSessionErrors),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const IssuedSessionJson = Schema.toCodecJson(ServerAuthIssuedSession);
const SessionListJson = Schema.toCodecJson(ServerAuthSessionList);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Have the running server issue a scoped bearer access token for headless or remote clients.",
  ),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "auth",
      { ...flags, quietLogs: flags.json || flags.tokenOnly },
      Effect.fn("cli.auth.session.issue")(function* (tools) {
        const issued = yield* tools.call(
          "t3_auth_session_issue",
          {
            scopes: flags.scopes,
            ...ttlArgument(flags.ttl),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
          },
          IssuedSessionJson,
        );
        yield* Console.log(
          formatIssuedSession(issued, { json: flags.json, tokenOnly: flags.tokenOnly }),
        );
      }),
    ).pipe(reportSessionErrors),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List the running server's active sessions without revealing bearer tokens.",
  ),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "auth",
      { ...flags, quietLogs: flags.json },
      Effect.fn("cli.auth.session.list")(function* (tools) {
        const { sessions } = yield* tools.call("t3_auth_session_list", {}, SessionListJson);
        yield* Console.log(formatSessionList(sessions, { json: flags.json }));
      }),
    ).pipe(reportSessionErrors),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.String("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Have the running server revoke an active session."),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "auth",
      flags,
      Effect.fn("cli.auth.session.revoke")(function* (tools) {
        const { revoked } = yield* tools.call(
          "t3_auth_session_revoke",
          { sessionId: flags.sessionId },
          ServerAuthSessionRevokeResult,
        );
        yield* Console.log(
          revoked
            ? `Revoked session ${flags.sessionId}.\n`
            : `No active session found for ${flags.sessionId}.\n`,
        );
      }),
    ).pipe(reportSessionErrors),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand]),
);
