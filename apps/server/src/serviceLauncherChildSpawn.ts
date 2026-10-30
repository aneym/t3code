// @effect-diagnostics nodeBuiltinImport:off -- Child spawning must survive unloadable server versions.
import * as NodeChildProcess from "node:child_process";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  type ServiceLauncherContext,
  type ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";
import type { LauncherIngressConfig } from "./serviceLauncherConfig.ts";
import { runtimePaths, runtimeSpawnArguments } from "./serviceLauncherState.ts";

export interface ManagedChild {
  readonly version: string;
  role: "active" | "trial";
  stateDirOwned: boolean;
  capable: boolean;
  readonly instanceId: string;
  readonly process: NodeChildProcess.ChildProcess;
}

export async function spawnServiceChild(options: {
  readonly baseDir: string;
  readonly version: string;
  readonly instanceId: string;
  readonly warm: boolean;
  readonly update: ServiceUpdateRecord | undefined;
  readonly ingress: LauncherIngressConfig | undefined;
  readonly maintenance: boolean;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly onError: (child: NodeChildProcess.ChildProcess) => void;
}) {
  const { version, instanceId, warm, update } = options;
  const paths = runtimePaths(options.baseDir, version);
  const context: ServiceLauncherContext = {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    childVersion: version,
    ...(options.ingress === undefined || options.maintenance
      ? {}
      : {
          hotSwap: {
            instanceId,
            warm,
            protocol: 1,
            publicHost: options.ingress.host,
            publicPort: options.ingress.port,
            holdBudgetMs: options.ingress.holdBudgetMs,
          },
        }),
    ...(update === undefined ? {} : { update }),
  };
  const spawnArguments = runtimeSpawnArguments(paths);
  const child = NodeChildProcess.spawn(spawnArguments.command, spawnArguments.args, {
    env: {
      ...options.environment,
      ...(options.ingress === undefined
        ? {}
        : {
            T3CODE_PORT: String(options.ingress.port),
            T3CODE_HOST: options.ingress.host,
          }),
      [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context),
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    child.once("error", onError);
    child.once("spawn", () => {
      child.removeListener("error", onError);
      child.on("error", () => options.onError(child));
      resolve();
    });
  });
  return child;
}
