import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { runCliLogin, type CliLoginPrompts } from "./cliLogin.ts";

export interface CliLoginMethod extends ProviderAuthMethod {
  readonly args: ReadonlyArray<string>;
  readonly prompts: CliLoginPrompts;
}

export const makeCliAuthController = Effect.fn("makeCliAuthController")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly credentialKey: string;
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly methods: ReadonlyArray<CliLoginMethod>;
  readonly logoutArgs: ReadonlyArray<string>;
  readonly isSignedIn: (
    run: (args: ReadonlyArray<string>) => Effect.Effect<number, ProviderSetupError>,
  ) => Effect.Effect<boolean, ProviderSetupError>;
  readonly onChanged: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const context = Context.pick(
    FileSystem.FileSystem,
    Path.Path,
  )(yield* Effect.context<FileSystem.FileSystem | Path.Path>());
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  const executable = resolveCommandPath(options.binaryPath, { env: options.env }).pipe(
    Effect.orElseSucceed(() => null),
    Effect.filterOrFail(
      (resolved): resolved is string => resolved !== null,
      () => failure("start", `Install ${options.displayName} before signing in.`),
    ),
    Effect.provide(context),
  );
  const run = (args: ReadonlyArray<string>) =>
    executable.pipe(
      Effect.flatMap((command) =>
        spawner.spawn(
          ChildProcess.make(command, [...args], {
            cwd: options.cwd,
            env: options.env,
            extendEnv: false,
            stdin: "ignore",
          }),
        ),
      ),
      Effect.flatMap((child) =>
        Effect.all(
          [child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain), child.exitCode],
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map(([, , exitCode]) => exitCode),
      Effect.scoped,
      Effect.timeout("60 seconds"),
      Effect.mapError((cause) =>
        cause._tag === "ProviderSetupError"
          ? cause
          : failure(
              "status",
              `Could not ask ${options.displayName} for its sign-in status.`,
              cause,
            ),
      ),
    );

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.credentialKey },
    methods: Effect.succeed(
      options.methods.map(({ args: _args, prompts: _prompts, ...method }) => method),
    ),
    refreshMethodsAfterAuth: false,
    timeoutMs: 600_000,
    authenticate: Effect.fn("CliAuthController.authenticate")(function* (methodId, flow) {
      const method = options.methods.find((candidate) => candidate.id === methodId);
      if (!method) return yield* failure("start", "This sign-in method is not available.");
      yield* runCliLogin({
        instanceId: options.instanceId,
        executablePath: yield* executable,
        args: method.args,
        env: options.env,
        cwd: options.cwd,
        prompts: method.prompts,
        context: flow,
      });
      yield* options.onChanged;
      if (!(yield* options.isSignedIn(run)))
        return yield* failure(
          "verify",
          `${options.displayName} did not report a signed-in account. Start sign-in again.`,
        );
    }),
    logout: run(options.logoutArgs).pipe(
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? Effect.void
          : Effect.fail(failure("logout", `${options.displayName} could not sign out.`)),
      ),
      Effect.ensuring(options.onChanged),
    ),
  });
});
