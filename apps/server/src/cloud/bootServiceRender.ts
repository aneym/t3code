import {
  CONNECTOR_UNIT_PATH_ENV,
  connectorUnitPath,
  serviceUnitFileName,
} from "../serviceConnectorUnit.ts";
import {
  associatedBundleEnvironmentPlistLines,
  associatedBundlePlistLines,
} from "./bootServiceAssociation.ts";
import { selfUpdateOffPlistLines, selfUpdateOffUnitLines } from "./selfUpdateSwitch.ts";
import { SERVICE_UNIT_ENV } from "./serviceProtocol.ts";

export const BOOT_SERVICE_NAME_ENV = "T3CODE_SERVICE_NAME";
const requestedServiceName = process.env[BOOT_SERVICE_NAME_ENV]?.trim() || undefined;
export const bootServiceNameProblem =
  requestedServiceName === undefined || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestedServiceName)
    ? undefined
    : `${BOOT_SERVICE_NAME_ENV} is "${requestedServiceName}"; use letters, digits, dots, dashes or underscores, starting with a letter or digit.`;
const BOOT_SERVICE_CUSTOM_NAME =
  bootServiceNameProblem === undefined ? requestedServiceName : undefined;
const BOOT_SERVICE_NAME = BOOT_SERVICE_CUSTOM_NAME ?? "t3code";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (com.t3tools.t3code), so launchd and TCC records never collide.
export const BOOT_SERVICE_LAUNCHD_LABEL = BOOT_SERVICE_CUSTOM_NAME ?? "com.t3tools.t3code.service";
const customNameUnitLines = BOOT_SERVICE_CUSTOM_NAME
  ? [`Environment=${BOOT_SERVICE_NAME_ENV}=${BOOT_SERVICE_CUSTOM_NAME}`]
  : [];
const customNamePlistLines = BOOT_SERVICE_CUSTOM_NAME
  ? [`    <key>${BOOT_SERVICE_NAME_ENV}</key>`, `    <string>${BOOT_SERVICE_CUSTOM_NAME}</string>`]
  : [];
export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
/** Task Scheduler keeps its own copy; this one lets status and repair read the task back. */
export const BOOT_SERVICE_TASK_FILE = `${BOOT_SERVICE_NAME}-task.xml`;
export const bootServiceUnitPath = (
  join: (...parts: ReadonlyArray<string>) => string,
  platform: NodeJS.Platform,
  homeDir: string,
) =>
  platform === "darwin"
    ? join(homeDir, "Library", "LaunchAgents", BOOT_SERVICE_PLIST_FILE)
    : join(homeDir, ".config", "systemd", "user", BOOT_SERVICE_UNIT_FILE);
export const BOOT_SERVICE_LOG_FILE = "boot-service.log";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

export function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

/** Windows paths cannot contain `"`; only backslashes before the closing quote need doubling. */
const quoteWindowsArgument = (value: string) => `"${value.replace(/(\\+)$/, "$1$1")}"`;

export interface BootServicePlan {
  readonly program: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
  readonly installBinDir?: string;
  readonly connectorUnitPath?: string;
  /** The manager accepted a detached install; its outcome is written to `logPath`. */
  readonly handedOff?: boolean;
}

/** Service units cannot rely on the user's shell or PATH. */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=T3 Code server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=T3CODE_HOME=${quoteSystemdValue(plan.baseDir)}`,
    ...(plan.installBinDir === undefined
      ? []
      : [`Environment=T3CODE_INSTALL_BIN_DIR=${quoteSystemdValue(plan.installBinDir)}`]),
    `Environment=${SERVICE_UNIT_ENV}=${quoteSystemdValue(serviceUnitFileName(plan.unitPath))}`,
    `Environment=${CONNECTOR_UNIT_PATH_ENV}=${quoteSystemdValue(plan.connectorUnitPath ?? connectorUnitPath(plan.unitPath))}`,
    ...customNameUnitLines,
    ...selfUpdateOffUnitLines,
    `ExecStart=${plan.program.map(quoteSystemdValue).join(" ")}`,
    // Let the launcher mark the stop before it signals the server.
    // Past TimeoutStopSec, systemd SIGKILLs the cgroup.
    "KillMode=mixed",
    "TimeoutStopSec=90s",
    // Helpers share this cgroup; default OOMPolicy=stop would stop the unit if one is OOM-killed.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    // Weights favor the server over the sibling agents slice during CPU or disk saturation.
    "CPUWeight=1000",
    "IOWeight=1000",
    "MemoryLow=1536M",
    "OOMScoreAdjust=100",
    // systemd-oomd ignores this preference when the watched cgroup is root-owned, as user-1000.slice usually is.
    "ManagedOOMPreference=avoid",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Launch agents cannot rely on the user's shell or PATH. */
export function renderBootServicePlist(
  plan: BootServicePlan,
  options: { readonly homeDir: string; readonly environmentPath: string },
): string {
  // Allow 90s stops for update handoffs.
  // Interactive avoids background throttling.
  // AbandonProcessGroup=false reaps agents only on launcher exit, preserving them across child updates.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXmlText(serviceUnitFileName(plan.unitPath).replace(/\.plist$/, ""))}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...plan.program.map((argument) => `    <string>${escapeXmlText(argument)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${escapeXmlText(options.environmentPath)}</string>`,
    `    <key>T3CODE_HOME</key>`,
    `    <string>${escapeXmlText(plan.baseDir)}</string>`,
    ...(plan.installBinDir === undefined
      ? []
      : [
          `    <key>T3CODE_INSTALL_BIN_DIR</key>`,
          `    <string>${escapeXmlText(plan.installBinDir)}</string>`,
        ]),
    `    <key>${SERVICE_UNIT_ENV}</key>`,
    `    <string>${escapeXmlText(serviceUnitFileName(plan.unitPath))}</string>`,
    `    <key>${CONNECTOR_UNIT_PATH_ENV}</key>`,
    `    <string>${escapeXmlText(plan.connectorUnitPath ?? connectorUnitPath(plan.unitPath))}</string>`,
    ...customNamePlistLines,
    ...associatedBundleEnvironmentPlistLines,
    ...selfUpdateOffPlistLines,
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXmlText(options.homeDir)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>90</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    ...associatedBundlePlistLines,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/**
 * Task Scheduler can neither set variables nor redirect output, so the launcher takes them as
 * flags. A console program started by a task opens a window unless a headless console hosts it.
 * No XML declaration: schtasks rejects `encoding="UTF-8"` but reads undeclared XML as UTF-8.
 */
export function renderBootServiceTask(
  plan: BootServicePlan,
  options: { readonly userId: string; readonly homeDir: string; readonly conhostPath: string },
): string {
  const launcherArguments = [
    ...plan.program,
    "--base-dir",
    plan.baseDir,
    "--log-file",
    plan.logPath,
    "--service-unit",
    BOOT_SERVICE_TASK_FILE,
  ]
    .map(quoteWindowsArgument)
    .join(" ");
  // conhost reports exit code 0 whatever the launcher returns, so restart-on-failure never
  // fires. A repeating trigger with IgnoreNew starts the task again within a minute instead.
  // Priority 5 is normal; the default 7 runs below it.
  return [
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>T3 Code server</Description>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger>`,
    `      <UserId>${escapeXmlText(options.userId)}</UserId>`,
    `    </LogonTrigger>`,
    `    <TimeTrigger>`,
    `      <StartBoundary>2000-01-01T00:00:00</StartBoundary>`,
    `      <Repetition>`,
    `        <Interval>PT1M</Interval>`,
    `      </Repetition>`,
    `    </TimeTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>${escapeXmlText(options.userId)}</UserId>`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <Priority>5</Priority>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>${escapeXmlText(options.conhostPath)}</Command>`,
    `      <Arguments>--headless ${escapeXmlText(launcherArguments)}</Arguments>`,
    `      <WorkingDirectory>${escapeXmlText(options.homeDir)}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\n");
}
