import type * as Duration from "effect/Duration";
const BOOT_SERVICE_NAME = "t3code";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
export const BOOT_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";
export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;
export const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";
export const BOOT_SERVICE_LOG_FILE = "boot-service.log";

function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

const unquoteSystemdValue = (raw: string) =>
  (raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : raw
  ).replaceAll("%%", "%");

const unescapeXmlText = (value: string) =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

export function bootServiceBaseDirOf(contents: string): string | undefined {
  const systemd = /^Environment=T3CODE_HOME=(.*)$/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd.trim());
  const plist = /<key>T3CODE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(contents)?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

export function bootServiceProgramOf(contents: string): string | undefined {
  const systemd = /^ExecStart=("(?:\\.|[^"\\])*"|\S+)/m.exec(contents)?.[1];
  if (systemd !== undefined) return unquoteSystemdValue(systemd);
  const plist = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
    contents,
  )?.[1];
  return plist === undefined ? undefined : unescapeXmlText(plist);
}

export interface BootServicePlan {
  readonly program: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
  readonly handedOff?: boolean;
}

export function renderBootServiceUnit(plan: BootServicePlan): string {
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
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${plan.program.map(quoteSystemdValue).join(" ")}`,
    "KillMode=mixed",
    "TimeoutStopSec=90s",
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    "CPUWeight=1000",
    "IOWeight=1000",
    "MemoryLow=1536M",
    "OOMScoreAdjust=100",
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

export function renderBootServicePlist(
  plan: BootServicePlan,
  options: { readonly homeDir: string; readonly environmentPath: string },
): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${BOOT_SERVICE_LAUNCHD_LABEL}</string>`,
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
    `    <key>${BOOT_SERVICE_UNIT_ENV}</key>`,
    `    <string>${BOOT_SERVICE_PLIST_FILE}</string>`,
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
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export interface BootServiceStep {
  readonly step: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly optional?: boolean;
  readonly timeout?: Duration.Input;
}
