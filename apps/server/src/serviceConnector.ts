// @effect-diagnostics nodeBuiltinImport:off -- An independent unit owns the connector and its configuration watch.
// @effect-diagnostics globalTimers:off -- Status refresh is independent of server and launcher lifetimes.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ServiceConnectorProcess } from "./serviceConnectorProcess.ts";
import type { ServiceConnectorConfig } from "./cloud/serviceProtocol.ts";

export async function runServiceConnector(baseDir: string): Promise<void> {
  const directory = NodePath.join(baseDir, "runtime");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const connector = new ServiceConnectorProcess();
  let transitions = Promise.resolve();
  const reconcile = async () => {
    let config: ServiceConnectorConfig | null = null;
    try {
      const value: unknown = JSON.parse(
        await NodeFSP.readFile(NodePath.join(directory, "connector-config.json"), "utf8"),
      );
      if (
        typeof value === "object" &&
        value !== null &&
        "executable" in value &&
        typeof value.executable === "string" &&
        "runtimeConfigPath" in value &&
        typeof value.runtimeConfigPath === "string"
      ) {
        const runtime: unknown = JSON.parse(
          await NodeFSP.readFile(value.runtimeConfigPath, "utf8"),
        );
        if (
          typeof runtime === "object" &&
          runtime !== null &&
          "connectorToken" in runtime &&
          typeof runtime.connectorToken === "string"
        )
          config = { executable: value.executable, token: runtime.connectorToken };
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    await connector.apply(config);
    await status();
  };
  const status = async () => {
    const temp = NodePath.join(directory, `.connector-status-${process.pid}.json`);
    await NodeFSP.writeFile(temp, JSON.stringify(await connector.inspect()), { mode: 0o600 });
    await NodeFSP.rename(temp, NodePath.join(directory, "connector-status.json"));
  };
  const enqueue = () => {
    transitions = transitions.then(reconcile, reconcile).catch(() => undefined);
  };
  const watcher = NodeFS.watch(directory, (_event, file) => {
    if (file === "connector-config.json") enqueue();
  });
  const timer = setInterval(enqueue, 5000);
  enqueue();
  try {
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  } finally {
    watcher.close();
    clearInterval(timer);
    await transitions;
    await connector.apply(null);
  }
}
