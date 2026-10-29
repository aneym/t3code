const fs = require("node:fs");
let context;
try { context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT || "null"); } catch {}
const mode = process.env.T3_REHEARSAL_FAULT;
if (context?.hotSwap?.warm === true && context?.update?.status === "pending" && typeof process.send === "function" && mode) {
  const original = process.send.bind(process);
  process.send = function (message, ...args) {
    const point = mode === "warm-death" ? "warm" : "validated";
    if (message?.type === point) {
      fs.writeFileSync(process.env.T3_REHEARSAL_FAULT_RECEIPT, JSON.stringify({ mode, point, updateId: context.update.id, version: context.childVersion, pid: process.pid, exitCode: mode === "warm-death" ? 86 : 87 }));
      process.exit(mode === "warm-death" ? 86 : 87);
    }
    return original(message, ...args);
  };
}
