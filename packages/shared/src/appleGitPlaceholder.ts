// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const APPLE_GIT_PLACEHOLDER = "/usr/bin/git";

const XCODE_SELECT = "/usr/bin/xcode-select";
const STANDARD_DEVELOPER_DIRS = [
  "/Library/Developer/CommandLineTools",
  "/Applications/Xcode.app/Contents/Developer",
];

interface DeveloperToolsAnswer {
  readonly dirs: ReadonlyArray<string>;
  readonly git: string | undefined;
  readonly installSignal: string;
}

const answers = new Map<string, DeveloperToolsAnswer>();

const isFile = (filePath: string) => {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const canExecute = (filePath: string) => {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return isFile(filePath);
  } catch {
    return false;
  }
};

const gitIn = (developerDir: string) => NodePath.join(developerDir, "usr", "bin", "git");

const printDeveloperDir = (env: NodeJS.ProcessEnv) => {
  try {
    const printed = NodeChildProcess.execFileSync(XCODE_SELECT, ["-p"], {
      encoding: "utf8",
      env,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return NodePath.isAbsolute(printed) ? printed : undefined;
  } catch {
    return undefined;
  }
};

const selectedDeveloperDirs = (env: NodeJS.ProcessEnv): ReadonlyArray<string> => {
  const overridden = env.DEVELOPER_DIR?.trim();
  if (overridden) return [overridden, NodePath.join(overridden, "Contents", "Developer")];
  const printed = printDeveloperDir(env);
  return printed === undefined ? [] : [printed];
};

const installSignalFor = (dirs: ReadonlyArray<string>) =>
  [...dirs, ...STANDARD_DEVELOPER_DIRS].map((dir) => (isFile(gitIn(dir)) ? "1" : "0")).join("");

export function locateDeveloperToolsGit(env: NodeJS.ProcessEnv): string | undefined {
  const key = env.DEVELOPER_DIR ?? "";
  const previous = answers.get(key);
  if (previous !== undefined && previous.installSignal === installSignalFor(previous.dirs)) {
    return previous.git;
  }
  const dirs = selectedDeveloperDirs(env);
  const git = dirs.map(gitIn).find(isFile);
  answers.set(key, { dirs, git, installSignal: installSignalFor(dirs) });
  return git;
}

const firstOnPath = (command: string, env: NodeJS.ProcessEnv) =>
  (env.PATH ?? "")
    .split(NodePath.delimiter)
    .filter((dir) => dir.length > 0)
    .map((dir) => NodePath.join(dir, command))
    .find(canExecute);

export function isAppleGitPlaceholder(
  command: string,
  env: NodeJS.ProcessEnv,
  locate: (env: NodeJS.ProcessEnv) => string | undefined,
): boolean {
  if (NodePath.basename(command) !== "git") return false;
  const runs = command.includes("/") ? NodePath.resolve(command) : firstOnPath(command, env);
  return runs === APPLE_GIT_PLACEHOLDER && locate(env) === undefined;
}
