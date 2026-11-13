// @effect-diagnostics nodeBuiltinImport:off -- The launcher repoints its unit outside the server runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  compareExactServiceVersions,
  disabledServiceTask,
  isExactServiceVersion,
  serviceTaskIsDisabled,
  serviceUnitBaseDirOf,
  SERVICE_UNIT_ENV,
  systemdUnitDirectoryOf,
  type ServiceState,
} from "./cloud/serviceProtocol.ts";
import { acquireServiceSelectionLock } from "./cloud/serviceSelectionLock.ts";
import {
  readServiceState,
  replaceFileDurably,
  sameServiceSelection,
} from "./serviceLauncherState.ts";

/**
 * The unit or launch agent that `t3 service install` wrote. Its program names
 * the runtime that ran the install, and a remote update never replaces it, so
 * after a commit the launcher points it at the committed runtime. Otherwise the
 * next start lands on a runtime that nothing in the service state records.
 */
export interface ServiceUnit {
  readonly path: string;
  /** systemd and Task Scheduler keep a loaded copy; launchd re-reads the plist at bootstrap. */
  readonly reload: () => Promise<void>;
}

/** Task Scheduler names are machine-wide, so each Windows account runs its own task. */
export const serviceTaskName = (domain: string, userName: string) => `t3code-${domain}-${userName}`;

const runSchtasks = (...args: ReadonlyArray<string>) =>
  NodeUtil.promisify(NodeChildProcess.execFile)("schtasks", args, {
    windowsHide: true,
    timeout: 30_000,
  });

/**
 * Registering replaces the task, so one the CLI disabled to keep the service stopped is
 * registered disabled. The caller holds the unit lease, as the CLI does to disable it.
 */
export async function registerServiceTask(
  unitPath: string,
  taskName: string,
  schtasks: (...args: ReadonlyArray<string>) => Promise<{ readonly stdout: string }> = runSchtasks,
): Promise<void> {
  const register = (xmlPath: string) => schtasks("/Create", "/XML", xmlPath, "/TN", taskName, "/F");
  const registered = await schtasks("/Query", "/TN", taskName, "/XML");
  if (!serviceTaskIsDisabled(registered.stdout)) {
    await register(unitPath);
    return;
  }
  const disabledPath = `${unitPath}.${process.pid}.disabled`;
  try {
    const unit = await NodeFSP.readFile(unitPath, "utf8");
    await NodeFSP.writeFile(disabledPath, disabledServiceTask(unit));
    await register(disabledPath);
  } finally {
    await NodeFSP.rm(disabledPath, { force: true });
  }
}

// The manager's environment can differ from the one it gives services (environment.d).
async function readSystemdUnitDirectory(): Promise<string | undefined> {
  try {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "busctl",
      [
        "--user",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "UnitPath",
      ],
      { timeout: 5_000 },
    );
    const { data } = JSON.parse(stdout) as { readonly data?: unknown };
    return Array.isArray(data) && data.every((entry) => typeof entry === "string")
      ? systemdUnitDirectoryOf(data)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function serviceUnitFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServiceUnit | undefined> {
  const unitName = env[SERVICE_UNIT_ENV]?.trim();
  if (!unitName) return undefined;
  if (unitName.endsWith(".xml")) {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) return undefined;
    const path = NodePath.win32.join(localAppData, "t3code", unitName);
    const taskName = serviceTaskName(env.USERDOMAIN ?? "", env.USERNAME ?? "");
    return { path, reload: () => registerServiceTask(path, taskName) };
  }
  const home = env.HOME?.trim();
  if (!home) return undefined;
  if (unitName.endsWith(".plist")) {
    return {
      path: NodePath.join(home, "Library", "LaunchAgents", unitName),
      reload: () => Promise.resolve(),
    };
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const unitDir =
    (await readSystemdUnitDirectory()) ??
    NodePath.join(
      xdgConfigHome && NodePath.isAbsolute(xdgConfigHome)
        ? xdgConfigHome
        : NodePath.join(home, ".config"),
      "systemd",
      "user",
    );
  return {
    path: NodePath.join(unitDir, unitName),
    reload: () =>
      new Promise((resolve, reject) => {
        NodeChildProcess.spawn("systemctl", ["--user", "daemon-reload"], {
          stdio: "ignore",
          timeout: 30_000,
        })
          .once("error", reject)
          .once("exit", (code, signal) =>
            code === 0
              ? resolve()
              : reject(new Error(`systemctl --user daemon-reload exited with ${code ?? signal}`)),
          );
      }),
  };
}

// systemd's ExecStart value, or the plist string or task argument before __service-launcher.
// Only the version segment changes, so quoted or escaped paths stay as rendered.
// The launch agent's PATH names a versions directory without the executable; leave it.
const SERVICE_UNIT_PROGRAMS = [
  /^(ExecStart=.*?[\\/]runtime[\\/]versions[\\/])([^\\/\s"]+)([\\/]t3)(?=["\s])/m,
  /(<string>[^<]*?[\\/]runtime[\\/]versions[\\/])([^\\/<]+)([\\/]t3<\/string>\s*<string>__service-launcher<\/string>)/,
  /(<Arguments>--headless "[^"<]*?[\\/]runtime[\\/]versions[\\/])([^\\/"<]+)([\\/]t3\.exe" "__service-launcher")/,
] as const;

/**
 * The unit contents with their program pointed at `version`'s runtime. A unit
 * already at that version or a newer one is returned unchanged: `t3 update`
 * may have repointed it to a later version while this commit was in flight.
 */
function repointServiceUnitContents(contents: string, version: string): string {
  for (const program of SERVICE_UNIT_PROGRAMS) {
    const match = program.exec(contents);
    if (match === null) continue;
    const [, prefix = "", current = "", suffix = ""] = match;
    if (isExactServiceVersion(current) && compareExactServiceVersions(current, version) >= 0) {
      return contents;
    }
    return contents.replace(program, () => `${prefix}${version}${suffix}`);
  }
  return contents;
}

// Selection is durable before this best-effort unit reconciliation.
export async function repointServiceUnit(options: {
  readonly unit: ServiceUnit | undefined;
  readonly baseDir: string;
  readonly statePath: string;
  readonly current: ServiceState;
  readonly version: string;
}): Promise<void> {
  const { unit, version } = options;
  if (unit === undefined) return;
  try {
    const release = await acquireServiceSelectionLock(unit.path);
    try {
      // The installer writes state before the unit under this lease. Do not
      // acquire its state lease here: the installer takes that lease first.
      if (!sameServiceSelection(await readServiceState(options.statePath), options.current)) return;
      const contents = await NodeFSP.readFile(unit.path, "utf8");
      const installedBaseDir = serviceUnitBaseDirOf(contents);
      if (
        installedBaseDir === undefined ||
        NodePath.resolve(installedBaseDir) !== NodePath.resolve(options.baseDir)
      ) {
        return;
      }
      const repointed = repointServiceUnitContents(contents, version);
      if (repointed !== contents) await replaceFileDurably(unit.path, repointed);
      // A previous rename may have succeeded before reload failed.
      await unit.reload();
    } finally {
      release();
    }
  } catch (error) {
    process.stderr.write(
      `[service-launcher] Could not point ${unit.path} at t3@${version}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
