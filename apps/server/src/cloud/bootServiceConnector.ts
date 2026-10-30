import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  BOOT_SERVICE_LAUNCHD_LABEL,
  BOOT_SERVICE_PLIST_FILE,
  BOOT_SERVICE_UNIT_FILE,
  type BootServiceManager,
  type BootServicePlan,
  type BootServiceStep,
} from "./bootService.ts";

const CONNECTOR_UNIT_FILE = "t3code-connector.service";
const CONNECTOR_LAUNCHD_LABEL = "com.t3tools.t3code-connector.service";

export function connectorServiceManager(manager: BootServiceManager): BootServiceManager {
  const replace = (value: string) =>
    value
      .replaceAll(BOOT_SERVICE_PLIST_FILE, `${CONNECTOR_LAUNCHD_LABEL}.plist`)
      .replaceAll(BOOT_SERVICE_LAUNCHD_LABEL, CONNECTOR_LAUNCHD_LABEL)
      .replaceAll(BOOT_SERVICE_UNIT_FILE, CONNECTOR_UNIT_FILE);
  const steps = (list: ReadonlyArray<BootServiceStep>) =>
    list.map((step) => ({ ...step, args: step.args.map(replace) }));
  return {
    ...manager,
    unitPath: replace(manager.unitPath),
    render: (plan) =>
      replace(manager.render(plan)).replace(
        "Description=T3 Code server",
        "Description=T3 Code tunnel connector",
      ),
    stop: steps(manager.stop),
    restart: steps(manager.restart),
    deactivate: steps(manager.deactivate),
    finalize: steps(manager.finalize),
    activate: steps(manager.activate).map((step) => ({
      ...step,
      args: step.args.map((arg) => (arg === "restart" ? "start" : arg)),
      ...(step.command === "launchctl" && step.args[0] === "bootstrap" ? { optional: true } : {}),
    })),
  };
}

export const writeConnectorService = Effect.fn("bootServiceConnector.write")(function* (
  manager: BootServiceManager,
  plan: BootServicePlan,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const connector = connectorServiceManager(manager);
  const nextPlan = {
    ...plan,
    program: [plan.program[0]!, "__service-connector"],
    unitPath: connector.unitPath,
    logPath: path.join(path.dirname(plan.logPath), "connector-service.log"),
  };
  const rendered = connector.render(nextPlan);
  const previous = yield* fs
    .readFileString(connector.unitPath)
    .pipe(Effect.orElseSucceed(() => ""));
  if (previous !== rendered) {
    yield* fs.makeDirectory(path.dirname(connector.unitPath), { recursive: true });
    const temporary = `${connector.unitPath}.pending`;
    yield* fs.writeFileString(temporary, rendered, { mode: 0o600 });
    yield* fs.rename(temporary, connector.unitPath);
  }
  return connector;
});
