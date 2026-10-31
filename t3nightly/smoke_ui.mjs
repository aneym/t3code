import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [treeArg, pairingFile, namesFile, outDir] = process.argv.slice(2);
const require = createRequire(`${treeArg}/apps/web/package.json`);
const { chromium } = require("playwright");
const names = JSON.parse(readFileSync(namesFile, "utf8"));
const pairingUrl = readFileSync(pairingFile, "utf8").match(/^Pairing URL: (\S+)$/m)?.[1];
if (!pairingUrl) throw new Error("no Pairing URL line");
mkdirSync(outDir, { recursive: true });

const stories = [];
let step = "";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(20000);

const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png` });
const sidebar = () => page.locator('[data-sidebar="sidebar"]').first();
const row = (title) => sidebar().getByRole("treeitem").filter({ hasText: title });
const agentRow = () => sidebar().getByRole("listitem").filter({ hasText: names.agent });
const visible = async (locator) => (await locator.count()) > 0 && (await locator.first().isVisible());

async function expect(condition, message) {
  if (!(await condition)) throw new Error(message);
}

async function waitShown(locator, message) {
  try {
    await locator.first().waitFor({ state: "visible" });
  } catch {
    throw new Error(message);
  }
}

async function waitGone(locator, message) {
  try {
    await locator.first().waitFor({ state: "hidden", timeout: 10000 });
  } catch {
    throw new Error(message);
  }
}

async function pickProject(label, option = label) {
  step = `pick ${label}`;
  await sidebar().getByRole("combobox", { name: /^Filter threads by project/ }).click();
  await page.getByLabel("Search projects").fill(label === "All projects" ? "" : label);
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.getByRole("option", { name: new RegExp(`(^|\\s)${escaped}$`) }).first().click();
}

async function showAgents() {
  const hidden = sidebar().getByRole("button", { name: /^Hidden \d+$/ });
  if (!(await visible(agentRow())) && (await visible(hidden))) await hidden.first().click();
}

async function agentButton(action) {
  step = `${action} button`;
  await showAgents();
  await agentRow().first().hover();
  await sidebar().getByRole("button", { name: `${action} ${names.agent}`, exact: true }).click();
}

async function story(name, body) {
  step = "";
  try {
    await body();
    await shot(name);
    stories.push({ name, ok: true });
  } catch (error) {
    await shot(`${name}-failed`).catch(() => {});
    await page.locator("body").ariaSnapshot().then((tree) => writeFileSync(`${outDir}/${name}-failed.aria.yml`, tree)).catch(() => {});
    stories.push({ name, ok: false, detail: `${step ? `${step}: ` : ""}${String(error?.message ?? error).split("\n")[0]}` });
  }
}

await story("pair-and-load", async () => {
  await page.goto(pairingUrl);
  try {
    await row(names.other).first().waitFor({ state: "visible", timeout: 60000 });
  } catch {
    throw new Error(`sidebar never listed the unrelated thread after pairing; page at ${page.url()}`);
  }
});
if (!stories[0].ok) {
  await browser.close();
  console.log(JSON.stringify({ ok: false, stories }));
  process.exit(0);
}

await story("main-thread-under-agent", async () => {
  await showAgents();
  await waitShown(agentRow(), "agent is not listed in the sidebar");
  await expect(agentRow().count().then((count) => count === 1), "agent is not listed exactly once");
  await waitGone(row(names.main), "the agent's main thread is also in the thread list");
});

await story("project-filter", async () => {
  await pickProject(names.otherProject);
  await waitShown(row(names.other), "filtered project's thread is missing");
  await waitGone(row(names.lane), "another project's thread stays visible under the filter");
  if (names.build >= 28) await waitShown(agentRow(), "pinned orch does not come along into another project view");
  else await waitGone(agentRow(), "another project's agent stays visible under the filter");
  await expect(visible(sidebar().getByRole("combobox", { name: `Filter threads by project: ${names.otherProject}` })), "filter button does not name the project");
  await pickProject("All projects");
  await waitShown(row(names.lane), "All projects did not bring the lane thread back");
});

await story("agent-focus-lanes", async () => {
  await agentButton("Focus");
  await waitShown(row(names.lane), "focused agent does not list its lane thread");
  await waitGone(row(names.other), "focused agent still lists an unrelated project's thread");
  await expect(visible(agentRow()), "focused agent row disappeared");
});

await story("filter-while-focused", async () => {
  await pickProject(names.otherProject);
  await waitShown(row(names.other), "filter while focused does not show the chosen project's thread");
  await waitGone(row(names.lane), "filter while focused keeps the agent's lane thread");
  if (names.build >= 28) await waitShown(agentRow(), "filter while focused dropped the pinned orch");
  else await waitGone(agentRow(), "filter while focused keeps the other project's agent");
  await pickProject("All projects");
  await waitShown(row(names.other), "All projects after focus did not restore threads");
  await waitShown(row(names.lane), "All projects after focus did not restore the lane");
});

await story("pinned-agent-in-project", async () => {
  if (names.build >= 28) await agentRow().first().hover();
  if (names.build >= 28) await waitShown(sidebar().getByRole("button", { name: `Unpin ${names.agent}`, exact: true }), "orch did not arrive pinned in Agents");
  else await agentButton("Pin");
  const pinned = sidebar().getByRole("list", { name: "Agents", exact: true }).getByRole("listitem").filter({ hasText: names.agent });
  await waitShown(pinned, "pinned agent is not under Agents");
  await pickProject(names.agentProject, names.build >= 33 ? names.agent : names.agentProject);
  await waitShown(pinned, "pinned agent does not carry into its project view");
  await pickProject(names.otherProject);
  if (names.build >= 26) await waitShown(pinned, "pinned agent does not come along into another project view");
  else await waitGone(pinned, "pinned agent leaks into an unrelated project view");
  await pickProject("All projects");
  await waitShown(pinned, "pin lost after leaving the project view");
  if (names.build >= 33) {
    await pickProject(names.agent);
    await waitShown(pinned, "searching the agent name does not reach its project view");
    await pickProject("All projects");
  }
});

await browser.close();
console.log(JSON.stringify({ ok: stories.every((entry) => entry.ok), stories }));
process.exit(0);
