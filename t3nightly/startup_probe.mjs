import { writeFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
const [binary, home, version, port] = process.argv.slice(2);
const updateId = "startup-qualification";
writeFileSync(`${home}/runtime/ownership-grant.json`, JSON.stringify({pid: process.pid, instanceId: updateId}), {mode: 0o600});
const context = {protocol: 3, childVersion: version, hotSwap: {instanceId: updateId, warm: true, protocol: 1, publicHost: "127.0.0.1", publicPort: Number(port), holdBudgetMs: 30000}, update: {id: updateId, fromVersion: version, targetVersion: version, dbPath: `${home}/userdata/statev2.sqlite`, status: "pending"}};
const child = spawn(binary, ["serve", "--base-dir", home, "--host", "127.0.0.1", "--port", port, "--no-browser"], {env: {...process.env, T3_SERVICE_LAUNCHER_CONTEXT: JSON.stringify(context)}, stdio: ["ignore", "inherit", "inherit", "ipc"]});
process.on("SIGTERM", () => { finished = true; child.kill(); process.exitCode = 1; });
let acquire;
let finished = false;
const timeout = setTimeout(() => { finished = true; child.kill(); process.exitCode = 1; }, 90000);
child.on("error", () => { finished = true; clearTimeout(timeout); process.exitCode = 1; });
child.on("message", message => {
  if (message.type === "ingress-ready") child.send({type: "ingress-bound", host: "127.0.0.1", port: Number(port)});
  if (message.type === "warm") { acquire = performance.now(); child.send({type: "acquire", updateId}); }
  if (message.type === "validated") {
    child.send({type: "committed", updateId});
    const check = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${message.port}/.well-known/t3/environment`);
        if (!response.ok || (await response.json()).serverVersion !== version) throw new Error("not ready");
        console.log(JSON.stringify({acquireToReadyMs: Math.ceil(performance.now() - acquire), measurement: "warm-acquire-to-environment-response"}));
        finished = true; clearTimeout(timeout); child.kill();
      } catch { if (!finished) setTimeout(check, 20); }
    };
    setTimeout(check, Number(process.env.T3_REHEARSAL_READY_DELAY_MS ?? 0));
  }
});
child.on("exit", () => { unlinkSync(`${home}/runtime/ownership-grant.json`); clearTimeout(timeout); if (!finished) process.exitCode = 1; });
