import {
  ProviderSetupError,
  type ProviderAuthInteraction,
  type ProviderAuthResponse,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { ProviderAuthFlowContext } from "@t3tools/provider-core/server/providerAuthFlow";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

const OSC_LINK = new RegExp(String.raw`\u001b\]8;;(https://[^\u0007\u001b]+)`, "u");
const ESCAPES = new RegExp(
  String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-Z0-9]`,
  "gu",
);
const PLAIN_URL = /https:\/\/[^\s"'<>]+/u;
const DEVICE_CODE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/u;

export interface CliLoginPrompts {
  readonly pasteCode?: RegExp;
  readonly deviceCode?: boolean;
}

const failure = (instanceId: ProviderInstanceId, detail: string, cause?: unknown) =>
  new ProviderSetupError({ instanceId, operation: "start", detail, cause });

const findInteraction = (
  transcript: string,
  prompts: CliLoginPrompts,
): ProviderAuthInteraction | null => {
  const plain = transcript.replace(ESCAPES, "");
  const url = OSC_LINK.exec(transcript)?.[1] ?? PLAIN_URL.exec(plain)?.[0];
  if (!url) return null;
  const userCode = prompts.deviceCode ? DEVICE_CODE.exec(plain)?.[1] : undefined;
  if (userCode) return { type: "deviceCode", id: "device-code", url, userCode };
  if (prompts.pasteCode?.test(plain))
    return {
      type: "credentials",
      id: "code",
      url,
      fields: [{ name: "code", label: "Code from your browser", secret: true }],
    };
  return { type: "browser", id: "browser", url, requiresConsent: false };
};

export const runCliLogin = Effect.fn("runCliLogin")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly prompts: CliLoginPrompts;
  readonly context: ProviderAuthFlowContext;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  if (Option.isNone(pty))
    return yield* failure(options.instanceId, "Sign-in is not available on this computer.");
  const exited = yield* Deferred.make<number>();
  const output = yield* Queue.unbounded<string>();
  const child = yield* pty.value
    .spawn({
      shell: options.executablePath,
      args: [...options.args],
      cwd: options.cwd,
      cols: 200,
      rows: 40,
      env: { ...options.env, TERM: "xterm-256color" },
    })
    .pipe(
      Effect.mapError((cause) => failure(options.instanceId, "Could not start sign-in.", cause)),
    );
  const detachData = child.onData((data) => {
    Queue.offerUnsafe(output, data);
  });
  const detachExit = child.onExit(({ exitCode }) => {
    Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
  });
  const signal = (name: NodeJS.Signals) =>
    Effect.sync(() => {
      try {
        signalProcessGroup(child.pid, name);
      } catch {}
    });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      detachData();
      if (yield* Deferred.isDone(exited)) return detachExit();
      yield* signal("SIGTERM");
      const stopped = yield* Deferred.await(exited).pipe(Effect.timeoutOption("3 seconds"));
      if (Option.isNone(stopped)) yield* signal("SIGKILL");
      detachExit();
    }),
  );
  const respond = (response: ProviderAuthResponse) => {
    const code = response.type === "credentials" ? response.values.code?.trim() : undefined;
    if (!code) return Effect.void;
    return Effect.try({
      try: () => child.write(`${code}\r`),
      catch: (cause) =>
        new ProviderSetupError({
          instanceId: options.instanceId,
          operation: "respond",
          detail: "The sign-in is no longer waiting for a code.",
          cause,
        }),
    });
  };
  let transcript = "";
  let shown = "";
  yield* Queue.take(output).pipe(
    Effect.flatMap((data) => {
      transcript = (transcript + data).slice(-65_536);
      const interaction = findInteraction(transcript, options.prompts);
      const key = interaction ? JSON.stringify(interaction) : "";
      if (!interaction || key === shown) return Effect.void;
      shown = key;
      return options.context.setInteraction(interaction, respond);
    }),
    Effect.forever,
    Effect.forkScoped,
  );
  const exitCode = yield* Deferred.await(exited);
  if (exitCode !== 0)
    return yield* failure(options.instanceId, "Sign-in did not finish. Start it again.");
  yield* options.context.verifying;
});
