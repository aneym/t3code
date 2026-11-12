import type { AuthSessionId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { cliRefusal } from "../cliRefusal.ts";
import { HOST_DAEMON_SUBJECT, HostDaemonScopes } from "../auth/McpClientSubjects.ts";
import * as ServerConfig from "../config.ts";
import * as CliAuthRuntime from "./cliAuthRuntime.ts";
import { authLocationFlags, DurationFromString, resolveCliAuthConfig } from "./config.ts";
import { type CachedCredential, readCredential, writeCredential } from "./credentialFile.ts";

const DEFAULT_TTL = Duration.days(90);
const RENEW_WITHIN = Duration.days(14);

const DaemonName = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name), {
      expected: "a name of letters, digits, '.', '_' or '-', at most 64 characters",
    }),
  ),
);

export class DaemonTokenRevokedError extends Schema.TaggedError<DaemonTokenRevokedError>()(
  "DaemonTokenRevokedError",
  { name: Schema.String, sessionId: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    return `Session ${this.sessionId} for daemon ${this.name} was revoked. Run again with --reissue to mint a new one.`;
  }
}

type Outcome = "issued" | "kept" | "renewed" | "reissued";

const report = (outcome: Outcome, name: string, path: string, credential: CachedCredential) =>
  Console.log(
    [
      `${outcome} daemon token ${name}`,
      `session: ${credential.sessionId}`,
      `file: ${path}`,
      `expires: ${DateTime.formatIso(DateTime.makeUnsafe(credential.expiresAtMs))}`,
      "",
    ].join("\n"),
  );

const run = Effect.fn("cli.auth.daemonToken.run")(function* (input: {
  readonly name: string;
  readonly ttl: Duration.Duration;
  readonly reissue: boolean;
  readonly secretsDir: string;
}) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const path = (yield* Path.Path).join(input.secretsDir, `daemon-${input.name}.json`);
  const existing = yield* readCredential(path);
  const now = yield* Clock.currentTimeMillis;

  const publish = Effect.fn("cli.auth.daemonToken.publish")(function* (
    outcome: Outcome,
    replaced: Option.Option<AuthSessionId>,
  ) {
    const issued = yield* auth.issueSession({
      subject: HOST_DAEMON_SUBJECT,
      label: input.name,
      scopes: HostDaemonScopes,
      ttl: input.ttl,
    });
    const credential: CachedCredential = {
      sessionId: issued.sessionId,
      token: issued.token,
      expiresAtMs: issued.expiresAt.epochMilliseconds,
    };
    yield* writeCredential(input.secretsDir, path, credential).pipe(
      Effect.tapError(() => auth.revokeSession(issued.sessionId).pipe(Effect.ignore)),
    );
    if (Option.isSome(replaced)) {
      yield* auth.revokeSession(replaced.value).pipe(Effect.ignore({ log: true }));
    }
    yield* report(outcome, input.name, path, credential);
  });

  if (Option.isNone(existing)) return yield* publish("issued", Option.none());
  const current = existing.value;
  const previous = Option.some(current.sessionId);
  if (input.reissue) return yield* publish("reissued", previous);

  const active = (yield* auth.listSessions()).some(
    (session) => session.sessionId === current.sessionId,
  );
  if (!active && current.expiresAtMs > now) {
    return yield* new DaemonTokenRevokedError({ name: input.name, sessionId: current.sessionId });
  }
  if (active && current.expiresAtMs - now > Duration.toMillis(RENEW_WITHIN)) {
    return yield* report("kept", input.name, path, current);
  }
  return yield* publish("renewed", previous);
});

export const daemonTokenCommand = Command.make("daemon-token", {
  ...authLocationFlags,
  name: Argument.String("name").pipe(
    Argument.withSchema(DaemonName),
    Argument.withDescription("Daemon name; the session label and the file name."),
  ),
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Lifetime of a newly minted session. Defaults to 90d."),
    Flag.optional,
  ),
  reissue: Flag.Boolean("reissue").pipe(
    Flag.withDescription("Mint a fresh session even when the current one was revoked."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Mint or renew a read-only host daemon session into a mode-600 file under the secrets directory. Never prints the token.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* run({
        name: flags.name,
        ttl: Option.getOrElse(flags.ttl, () => DEFAULT_TTL),
        reissue: flags.reissue,
        secretsDir: config.secretsDir,
      }).pipe(
        Effect.provide(
          CliAuthRuntime.layer.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
    }),
  ),
);
