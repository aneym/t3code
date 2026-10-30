import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
const production = await import(pathToFileURL(`${request.tree}/apps/server/src/cloud/bootService.ts`).href);
const program = ["/usr/bin/env", ...Object.entries(request.environment).map(([key, value]) => `${key}=${value}`), ...request.program];
const plan = { program, baseDir: request.home, logPath: request.log, unitPath: request.unit };
if (request.connectorUnit) plan.connectorUnitPath = request.connectorUnit;
const render = (plan) => request.platform === "darwin"
  ? production.renderBootServicePlist(plan, { homeDir: request.home, environmentPath: request.environment.PATH })
  : production.renderBootServiceUnit(plan);
let text;
if (request.kind === "connector") {
  const { connectorServiceManager } = await import(pathToFileURL(`${request.tree}/apps/server/src/cloud/bootServiceConnector.ts`).href);
  plan.connectorUnitPath = request.unit;
  const manager = connectorServiceManager({ unitPath: request.unit, render, stop: [], restart: [], deactivate: [], finalize: [], activate: [] }, plan.connectorUnitPath);
  text = manager.render(plan);
} else text = render(plan);
process.stdout.write(text);
