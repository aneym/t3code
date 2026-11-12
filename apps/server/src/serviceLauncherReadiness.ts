// @effect-diagnostics globalDate:off -- The standalone watchdog has no Effect clock and uses a bounded wall-clock deadline.
// @effect-diagnostics nodeBuiltinImport:off -- Qualification probes the actual public endpoint outside the child runtime.
// @effect-diagnostics globalTimers:off -- The watchdog bounds startup; polling stops when the spawned child exits.
import type * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";

export async function waitForServiceReadiness(
  baseDir: string,
  child: NodeChildProcess.ChildProcess,
  version: string,
  routable: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    if (routable()) {
      try {
        const state: unknown = JSON.parse(
          await NodeFSP.readFile(NodePath.join(baseDir, "userdata", "server-runtime.json"), "utf8"),
        );
        if (
          typeof state === "object" &&
          state !== null &&
          "pid" in state &&
          state.pid === child.pid &&
          "serverVersion" in state &&
          state.serverVersion === version &&
          "port" in state &&
          typeof state.port === "number"
        ) {
          const host =
            "host" in state &&
            typeof state.host === "string" &&
            state.host !== "0.0.0.0" &&
            state.host !== "::"
              ? state.host
              : "127.0.0.1";
          if (await probePublicEndpoint(host, state.port, version)) return true;
        }
      } catch {}
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function probePublicEndpoint(host: string, port: number, version: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = NodeHttp.get(
      { host, port, path: "/.well-known/t3/environment", agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (body.length < 65_536) body += chunk;
          else response.destroy();
        });
        response.on("error", () => resolve(false));
        response.on("end", () => {
          try {
            const descriptor: unknown = JSON.parse(body);
            resolve(
              response.statusCode === 200 &&
                typeof descriptor === "object" &&
                descriptor !== null &&
                "serverVersion" in descriptor &&
                descriptor.serverVersion === version,
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    request.setTimeout(1000, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}
