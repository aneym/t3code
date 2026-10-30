import { connectorUnitPath, serviceUnitFileName } from "../serviceConnectorUnit.ts";
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

export function connectorServiceManager(
  manager: BootServiceManager,
  unitPath = connectorUnitPath(manager.unitPath),
): BootServiceManager {
  const mainFile = serviceUnitFileName(manager.unitPath);
  const connectorFile = serviceUnitFileName(unitPath);
  const replacements = new Map([
    [manager.unitPath, unitPath],
    [mainFile, connectorFile],
    [mainFile.replace(/\.plist$/, ""), connectorFile.replace(/\.plist$/, "")],
    [BOOT_SERVICE_PLIST_FILE, connectorFile],
    [BOOT_SERVICE_LAUNCHD_LABEL, connectorFile.replace(/\.plist$/, "")],
    [BOOT_SERVICE_UNIT_FILE, connectorFile],
  ]);
  const pattern = new RegExp(
    [...replacements.keys()]
      .sort((a, b) => b.length - a.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g",
  );
  const replace = (value: string) => value.replace(pattern, (match) => replacements.get(match)!);
  const steps = (list: ReadonlyArray<BootServiceStep>) =>
    list.map((step) => ({ ...step, args: step.args.map(replace) }));
  return {
    ...manager,
    unitPath,
    render: (plan) =>
      manager
        .render({ ...plan, unitPath, connectorUnitPath: unitPath })
        .replace("Description=T3 Code server", "Description=T3 Code tunnel connector"),
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
  const connector = connectorServiceManager(manager, plan.connectorUnitPath);
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
