import http from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [origin, stop, output, capacityText, budgetText, milestones, expectedVersion, mode] = process.argv.slice(2);
const capacity = Number(capacityText);
const budget = Number(budgetText);
if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8192 || !Number.isInteger(budget) || budget < 1 || budget > 120000 || !["capacity", "budget"].includes(mode)) throw new Error("unsafe pressure budget");
const started = Date.now();
const data = { mode, capacity, budgetMs: budget, expectedVersion, status: "waiting-for-HOLD", requests: [], milestones: [], trigger: null };
const save = () => { writeFileSync(`${output}.next`, JSON.stringify(data)); renameSync(`${output}.next`, output); };
const one = (index) => new Promise((resolve) => {
  const row = { index, startedAt: new Date().toISOString(), connectedAt: null, finishedAt: null, durationMs: null, outcome: null, version: null, statusCode: null };
  const at = Date.now();
  let done = false;
  const finish = (outcome) => { if (done) return; done = true; row.outcome = outcome; row.finishedAt = new Date().toISOString(); row.durationMs = Date.now() - at; data.requests.push(row); save(); resolve(); };
  const request = http.get(`${origin}/.well-known/t3/environment`, { agent: false, timeout: budget + 10000 }, (response) => {
    row.statusCode = response.statusCode;
    let body = "";
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => { try { row.version = JSON.parse(body).serverVersion; finish("served"); } catch { finish("invalid-response"); } });
    response.on("error", (error) => finish(error.code ?? "response-error"));
  });
  request.on("socket", (socket) => socket.once("connect", () => { row.connectedAt = new Date().toISOString(); }));
  request.on("timeout", () => { finish("client-timeout"); request.destroy(); });
  request.on("error", (error) => finish(error.code ?? "request-error"));
});
save();
while (!existsSync(stop) && Date.now() - started < 240000) {
  if (existsSync(milestones)) {
    data.milestones = readFileSync(milestones, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    data.trigger = data.milestones.find((item) => item.phase === "validated-held") ?? null;
    if (data.trigger) break;
  }
  await delay(10);
}
if (data.trigger) {
  data.status = "HOLD-burst";
  save();
  await Promise.all(Array.from({ length: capacity + 2 }, (_, index) => one(index)));
  data.status = "complete";
  data.servedNew = data.requests.filter((row) => row.outcome === "served" && row.version === expectedVersion).length;
  data.servedOld = data.requests.filter((row) => row.outcome === "served" && row.version !== expectedVersion).length;
  data.refused = data.requests.filter((row) => row.outcome === "ECONNREFUSED").length;
  data.reset = data.requests.filter((row) => row.outcome === "ECONNRESET").length;
  data.pastBudget = data.requests.filter((row) => row.durationMs >= budget - 200 && row.outcome !== "served").length;
} else data.status = "HOLD-not-observed";
save();
