import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { makeCliAuthController } from "./cliAuthController.ts";

const PASTE_CODE = /paste code/iu;

export const makeClaudeCliAuth = (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly configDir: string;
  readonly onChanged: Effect.Effect<void>;
}) =>
  makeCliAuthController({
    instanceId: options.instanceId,
    displayName: "Claude",
    credentialKey: `claude:${options.configDir}`,
    binaryPath: options.binaryPath,
    env: options.env,
    cwd: options.cwd,
    methods: [
      {
        id: "claudeai",
        name: "Claude account",
        description: "Sign in with your Claude Pro, Max, Team or Enterprise plan.",
        type: "agent",
        args: ["auth", "login", "--claudeai"],
        prompts: { pasteCode: PASTE_CODE },
      },
      {
        id: "console",
        name: "Anthropic Console",
        description: "Sign in with an Anthropic Console account billed by usage.",
        type: "agent",
        args: ["auth", "login", "--console"],
        prompts: { pasteCode: PASTE_CODE },
      },
    ],
    logoutArgs: ["auth", "logout"],
    isSignedIn: (run) => run(["auth", "status"]).pipe(Effect.map((exitCode) => exitCode === 0)),
    onChanged: options.onChanged,
  });
