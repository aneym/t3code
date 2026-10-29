import http from "node:http";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [origin, stop, output, capacityText, budgetText] = process.argv.slice(2);
const capacity = Number(capacityText);
const budget = Number(budgetText);
if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8192 || !Number.isInteger(budget) || budget < 1 || budget > 300000) throw new Error("unsafe pressure budget");
const data = { capacity, clients: capacity + 1, batches: 0, completed: 0, refused: 0, reset: 0, timedOut: 0, otherFailures: 0, maxInFlight: 0 };
let inFlight = 0;
const one = () => new Promise((resolve) => {
  inFlight++;
  data.maxInFlight = Math.max(data.maxInFlight, inFlight);
  let settled = false;
  const done = () => { if (!settled) { settled = true; inFlight--; resolve(); } };
  const request = http.get(`${origin}/.well-known/t3/environment`, { agent: false, timeout: budget + 2000 }, (response) => {
    response.resume();
    response.on("end", () => { data.completed++; done(); });
    response.on("error", () => { data.reset++; done(); });
  });
  request.on("timeout", () => { data.timedOut++; request.destroy(); done(); });
  request.on("error", (error) => {
    if (error.code === "ECONNREFUSED") data.refused++;
    else if (error.code === "ECONNRESET") data.reset++;
    else data.otherFailures++;
    done();
  });
});
while (!existsSync(stop)) {
  await Promise.all(Array.from({ length: capacity + 1 }, one));
  data.batches++;
  writeFileSync(`${output}.next`, JSON.stringify(data));
  renameSync(`${output}.next`, output);
  await delay(100);
}
writeFileSync(`${output}.next`, JSON.stringify(data));
renameSync(`${output}.next`, output);
