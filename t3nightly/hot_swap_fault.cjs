const fs = require("node:fs");
if (process.argv.includes("__service-launcher") && process.env.T3_REHEARSAL_BAD_LAUNCHER) {
  const digest = require("node:crypto").createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  if (digest === process.env.T3_REHEARSAL_BAD_LAUNCHER) {
    fs.appendFileSync(process.env.T3_REHEARSAL_LAUNCHER_DEATHS, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), exit: 88 }) + "\n");
    process.exit(88);
  }
}
let context;
try { context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT || "null"); } catch {}
const mode = process.env.T3_REHEARSAL_FAULT;
const receipt = process.env.T3_REHEARSAL_IPC_RECEIPT;
if (context && typeof process.send === "function") {
  const original = process.send.bind(process);
  const record = (message, phase = message.type) => {
    if (receipt && ["warm", "drained", "validated", "state-dir-owned", "validated-held", "validated-released"].includes(phase)) fs.appendFileSync(receipt, JSON.stringify({ at: new Date().toISOString(), phase, updateId: message.updateId ?? context.update?.id, version: context.childVersion, pid: process.pid }) + "\n");
  };
  process.send = function (message, ...args) {
    record(message);
    if (context.hotSwap?.warm === true && context.update?.status === "pending") {
      const point = mode === "warm-death" ? "warm" : "validated";
      if (mode && message?.type === point) {
        fs.writeFileSync(process.env.T3_REHEARSAL_FAULT_RECEIPT, JSON.stringify({ mode, point, updateId: context.update.id, version: context.childVersion, pid: process.pid, exitCode: mode === "warm-death" ? 86 : 87 }));
        process.exit(mode === "warm-death" ? 86 : 87);
      }
      const hold = Number(process.env.T3_REHEARSAL_VALIDATED_HOLD_MS || 0);
      if (message?.type === "validated" && hold > 0) {
        record(message, "validated-held");
        setTimeout(() => { record(message, "validated-released"); original(message, ...args); }, hold);
        return true;
      }
    }
    return original(message, ...args);
  };
}
