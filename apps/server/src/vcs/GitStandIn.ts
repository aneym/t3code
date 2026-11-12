// @effect-diagnostics nodeBuiltinImport:off - the stand-in is written synchronously from raw spawn paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { isAppleGitPlaceholder } from "@t3tools/shared/appleGitPlaceholder";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { XcodeGitLocation } from "@t3tools/shared/shell";

const script = (root: string) =>
  [
    "#!/bin/sh",
    `[ "$DEVELOPER_DIR" = '${root}' ] && unset DEVELOPER_DIR`,
    'for d in "$(/usr/bin/xcode-select -p 2>/dev/null)" /Library/Developer/CommandLineTools /Applications/Xcode.app/Contents/Developer; do',
    '  [ -n "$d" ] && [ -x "$d/usr/bin/git" ] && exec "$d/usr/bin/git" "$@"',
    "done",
    'echo "git: command not found" >&2',
    "exit 127",
    "",
  ].join("\n");

let root: string | undefined;

const standInRoot = () => {
  if (root !== undefined && NodeFS.existsSync(NodePath.join(root, "usr", "bin", "git"))) {
    return root;
  }
  if (root === undefined) {
    process.once("exit", () => {
      if (root !== undefined) NodeFS.rmSync(root, { recursive: true, force: true });
    });
  }
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-git-stand-in-"));
  NodeFS.mkdirSync(NodePath.join(root, "usr", "bin"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "usr", "bin", "git"), script(root), { mode: 0o755 });
  return root;
};

export const withGitStandIn = (
  env: NodeJS.ProcessEnv,
  locate: (env: NodeJS.ProcessEnv) => string | undefined,
): NodeJS.ProcessEnv => {
  if (!isAppleGitPlaceholder("git", env, locate)) return env;
  const developerDir = standInRoot();
  const bin = NodePath.join(developerDir, "usr", "bin");
  return {
    ...env,
    DEVELOPER_DIR: developerDir,
    PATH: [bin, env.PATH].filter(Boolean).join(NodePath.delimiter),
  };
};

export const environment = Effect.fn("GitStandIn.environment")(function* (env: NodeJS.ProcessEnv) {
  if ((yield* HostProcess.Platform) !== "darwin") return env;
  return withGitStandIn(env, yield* XcodeGitLocation);
});
