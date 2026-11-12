import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeCliAuthController } from "./cliAuthController.ts";

export const makeCodexCliAuth = (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly codexHome: string;
  readonly refresh: Effect.Effect<ServerProvider>;
}) =>
  makeCliAuthController({
    instanceId: options.instanceId,
    displayName: "Codex",
    credentialKey: `codex:${options.codexHome}`,
    binaryPath: options.binaryPath,
    env: options.env,
    cwd: options.cwd,
    methods: [
      {
        id: "chatgpt",
        name: "ChatGPT account",
        description: "Sign in with your ChatGPT plan in your browser.",
        type: "agent",
        args: ["login"],
        prompts: {},
      },
      {
        id: "device-code",
        name: "Sign in with a code",
        description:
          "For when the browser cannot return to this computer. Turn on device code sign-in in ChatGPT's security settings first.",
        type: "agent",
        args: ["login", "--device-auth"],
        prompts: { deviceCode: true },
      },
    ],
    logoutArgs: ["logout"],
    isSignedIn: () =>
      options.refresh.pipe(Effect.map((provider) => provider.auth.status === "authenticated")),
    onChanged: Effect.asVoid(options.refresh),
  });
