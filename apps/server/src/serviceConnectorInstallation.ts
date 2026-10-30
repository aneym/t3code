// @effect-diagnostics nodeBuiltinImport:off -- Native qualification runs before the server Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export async function connectorServiceInstalled(baseDir: string, manager: "launchd" | "systemd") {
  const path =
    manager === "launchd"
      ? NodePath.join(
          NodeOS.homedir(),
          "Library",
          "LaunchAgents",
          "com.t3tools.t3code-connector.service.plist",
        )
      : NodePath.join(NodeOS.homedir(), ".config", "systemd", "user", "t3code-connector.service");
  try {
    const unit = await NodeFSP.readFile(path, "utf8");
    const home =
      manager === "launchd"
        ? baseDir.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        : baseDir;
    return unit.includes("__service-connector") && unit.includes(home);
  } catch {
    return false;
  }
}
