// @effect-diagnostics nodeBuiltinImport:off -- Native qualification runs before the server Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { CONNECTOR_UNIT_PATH_ENV } from "./serviceConnectorUnit.ts";
import { quoteSystemdValue } from "./cloud/bootServiceRender.ts";

export async function connectorServiceInstalled(baseDir: string, manager: "launchd" | "systemd") {
  const requested =
    NodeProcess.env[CONNECTOR_UNIT_PATH_ENV] ??
    (manager === "launchd"
      ? NodePath.join(
          NodeOS.homedir(),
          "Library",
          "LaunchAgents",
          "com.t3tools.t3code-connector.service.plist",
        )
      : NodePath.join(NodeOS.homedir(), ".config", "systemd", "user", "t3code-connector.service"));
  if (!NodePath.isAbsolute(requested) || requested !== NodePath.resolve(requested)) return false;
  let path: string;
  try {
    path = await NodeFSP.realpath(requested);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return false;
    path = NodePath.resolve(requested);
  }
  const parent = NodePath.dirname(path);
  if (
    manager === "launchd"
      ? !path.endsWith(".plist") || NodePath.basename(parent) !== "LaunchAgents"
      : !path.endsWith(".service") ||
        NodePath.basename(parent) !== "user" ||
        NodePath.basename(NodePath.dirname(parent)) !== "systemd"
  )
    return false;
  try {
    const unit = await NodeFSP.readFile(path, "utf8");
    const home =
      manager === "launchd"
        ? baseDir.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        : quoteSystemdValue(baseDir);
    return unit.includes("__service-connector") && unit.includes(home);
  } catch {
    return false;
  }
}
