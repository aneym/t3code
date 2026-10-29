// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

const copyHelpers = new Set<NodeChildProcess.ChildProcess>();

export function runCp(args: ReadonlyArray<string>): Promise<boolean> {
  return new Promise((resolve) => {
    const helper = NodeChildProcess.execFile("cp", args, (error) => {
      copyHelpers.delete(helper);
      resolve(error === null);
    });
    copyHelpers.add(helper);
  });
}

export function killCopyHelpers(): void {
  for (const helper of copyHelpers) helper.kill("SIGKILL");
}

// macOS fs.copyFile clone flags fall back to full copies.
export async function copyDatabaseFile(source: string, destination: string): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  // cp -c replaces files and breaks hard links; copy into hard-linked destinations instead.
  const hardLinked =
    platform === "darwin" &&
    ((await NodeFSP.stat(destination).catch(() => undefined))?.nlink ?? 1) > 1;
  const args =
    platform === "darwin" && !hardLinked
      ? ["-c", source, destination]
      : platform === "linux"
        ? ["--reflink=auto", source, destination]
        : undefined;
  if (args === undefined || !(await runCp(args))) await NodeFSP.copyFile(source, destination);
}
