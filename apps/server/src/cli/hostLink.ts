// @effect-diagnostics nodeBuiltinImport:off -- The link token is read from piped stdin so it never sits in argv or shell history.
import * as NodeFS from "node:fs";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as GlobalFlag from "effect/cli/GlobalFlag";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { HOST_LINK_TOKEN_SECRET } from "../hostLink/hostLinkToken.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const runWithLinkStores = Effect.fn("hostLink.runWithLinkStores")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (stores: {
    readonly settings: ServerSettings.ServerSettingsService["Service"];
    readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  }) => Effect.Effect<A, E>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
  return yield* Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    return yield* run({ settings, secrets });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerSecretStore.layer,
              SqlitePersistence.layerConfig,
              ManagedPolicy.layer,
            ),
          ),
        ),
        ServerSecretStore.layer,
      ).pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
  );
});

const readPipedToken = () =>
  Effect.sync(() => {
    if (process.stdin.isTTY) return Option.none<string>();
    const text = NodeFS.readFileSync(0, "utf8").trim();
    return text === "" ? Option.none<string>() : Option.some(text);
  });

const hostLinkSetCommand = Command.make("set", {
  ...authLocationFlags,
  url: Argument.String("url").pipe(
    Argument.withDescription("The host app's link address, ws:// or wss://."),
  ),
}).pipe(
  Command.withDescription(
    "Link this environment to a host app. Pipe the host's link token on stdin; threads with a lane push their events there.",
  ),
  Command.withHandler((flags) =>
    runWithLinkStores(flags, ({ settings, secrets }) =>
      Effect.gen(function* () {
        if (!/^wss?:\/\//.test(flags.url)) {
          return yield* Console.error("The link address must start with ws:// or wss://.\n");
        }
        const token = yield* readPipedToken();
        if (Option.isSome(token)) {
          yield* secrets.set(HOST_LINK_TOKEN_SECRET, new TextEncoder().encode(token.value));
        }
        yield* settings.updateSettings({ hostLinkEnabled: true, hostLinkUrl: flags.url });
        yield* Console.log(
          `Host link on: ${flags.url}${Option.isSome(token) ? ", token saved" : ", token unchanged"}.\n`,
        );
      }),
    ),
  ),
);

const hostLinkOffCommand = Command.make("off", { ...authLocationFlags }).pipe(
  Command.withDescription("Turn the host app link off and forget its token. Thread lanes stay."),
  Command.withHandler((flags) =>
    runWithLinkStores(flags, ({ settings, secrets }) =>
      Effect.gen(function* () {
        yield* secrets.remove(HOST_LINK_TOKEN_SECRET);
        yield* settings.updateSettings({ hostLinkEnabled: false });
        yield* Console.log("Host link off.\n");
      }),
    ),
  ),
);

const hostLinkShowCommand = Command.make("show", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Show the host app link settings. Its live state is in the t3_host_link_status tool.",
  ),
  Command.withHandler((flags) =>
    runWithLinkStores(flags, ({ settings, secrets }) =>
      Effect.gen(function* () {
        const current = yield* settings.getSettings;
        const token = yield* secrets.get(HOST_LINK_TOKEN_SECRET);
        yield* Console.log(
          `${current.hostLinkEnabled ? "on" : "off"} ${current.hostLinkUrl || "(no address)"}, token ${Option.isSome(token) ? "set" : "not set"}\n`,
        );
      }),
    ),
  ),
);

export const hostLinkCommand = Command.make("host-link").pipe(
  Command.withDescription("Link this environment to a host app that follows its threads."),
  Command.withSubcommands([hostLinkSetCommand, hostLinkOffCommand, hostLinkShowCommand]),
);
