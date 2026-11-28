export const CARD_LIMITS = {
  nodes: 12,
  depth: 4,
  chars: 8000,
  stats: 6,
  fields: 4,
  rows: 20,
  list: 20,
  chart: 24,
  spark: 24,
  tabs: 5,
  actions: 4,
  text: 200,
  body: 600,
  label: 40,
  height: 520,
} as const;

export const CARD_TONES = ["neutral", "info", "success", "warning", "destructive"] as const;
export type CardTone = (typeof CARD_TONES)[number];
export type CardBadge = { label: string; tone?: CardTone | undefined };
export type CardAction = { kind: "fill"; prompt: string } | { kind: "link"; url: string };
export type CardStat = { label: string; value: string | number; change?: string | undefined; tone?: "good" | "bad" | "neutral" | undefined; note?: string | undefined; spark?: number[] | undefined };
export type CardChartItem = { label: string; value: number; shown?: string | undefined };
export type CardField = { key: string; label?: string | undefined; as?: "number" | "money" | "date" | "badge" | undefined; tones?: Record<string, CardTone> | undefined };
export type CardCell = string | number | boolean | null;
export type CardListItem = { title: string; subtitle?: string | undefined; meta?: string | undefined; badge?: CardBadge | undefined };
export type CardUnit = "number" | "money" | "percent";

export type CardNode =
  | { type: "Stack"; direction?: "col" | "row" | undefined; gap?: "sm" | "md" | undefined; children: string[] }
  | { type: "Grid"; minColPx?: number | undefined; children: string[] }
  | { type: "Card"; title: string; subtitle?: string | undefined; badge?: CardBadge | undefined; children: string[] }
  | { type: "Stats"; heading?: string | undefined; items: CardStat[] }
  | { type: "Chart"; as?: "bar" | "line" | "donut" | undefined; heading?: string | undefined; sub?: string | undefined; unit?: CardUnit | undefined; items: CardChartItem[]; target?: number | undefined; targetLabel?: string | undefined }
  | { type: "Table"; heading?: string | undefined; fields: CardField[]; items: Record<string, CardCell>[] }
  | { type: "List"; heading?: string | undefined; items: CardListItem[] }
  | { type: "Badge"; label: string; tone?: CardTone | undefined }
  | { type: "ActionRow"; items: { label: string; variant?: "primary" | "secondary" | "ghost" | undefined; action: CardAction }[] }
  | { type: "Tabs"; defaultTab?: string | undefined; tabs: { id: string; label: string; child: string }[] }
  | { type: "Callout"; title?: string | undefined; body: string; tone?: Exclude<CardTone, "neutral"> | undefined };

export type CardType = CardNode["type"];
export type InlineCard = { v: 1; title?: string | undefined; root: string; nodes: Record<string, CardNode> };
export type CardRead = { ok: true; card: InlineCard } | { ok: false; error: string };

const NODE_KEYS: Record<CardType, string[]> = {
  Stack: ["direction", "gap", "children"],
  Grid: ["minColPx", "children"],
  Card: ["title", "subtitle", "badge", "children"],
  Stats: ["heading", "items"],
  Chart: ["as", "heading", "sub", "unit", "items", "target", "targetLabel"],
  Table: ["heading", "fields", "items"],
  List: ["heading", "items"],
  Badge: ["label", "tone"],
  ActionRow: ["items"],
  Tabs: ["defaultTab", "tabs"],
  Callout: ["title", "body", "tone"],
};
export const CARD_TYPES = Object.keys(NODE_KEYS) as CardType[];
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

class Bad extends Error {}
function fail(path: string, why: string): never {
  throw new Bad(`${path} ${why}`);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function obj(v: unknown, path: string, keys: string[]): Obj {
  if (!isObj(v)) fail(path, "must be an object");
  for (const k of Object.keys(v as Obj)) if (!keys.includes(k)) fail(`${path}.${k}`, `is not a field here; use ${keys.join(", ")}`);
  return v as Obj;
}

function text(v: unknown, path: string, max: number = CARD_LIMITS.text): string {
  if (typeof v !== "string" || !v.trim()) fail(path, "must be non-empty text");
  if ((v as string).length > max) fail(path, `must be at most ${max} characters`);
  return (v as string).trim();
}

const maybe = <T>(v: unknown, read: (v: unknown) => T): T | undefined => (v === undefined ? undefined : read(v));

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e12) fail(path, "must be a number between -1e12 and 1e12");
  return v as number;
}

function pick<T extends string>(v: unknown, path: string, options: readonly T[]): T {
  if (typeof v !== "string" || !options.includes(v as T)) fail(path, `must be one of ${options.join(", ")}`);
  return v as T;
}

function list(v: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, "must be a list");
  const a = v as unknown[];
  if (a.length < min || a.length > max) fail(path, `must have ${min} to ${max} entries`);
  return a;
}

const clean = <T extends Obj>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function badge(v: unknown, path: string): CardBadge {
  const b = obj(v, path, ["label", "tone"]);
  return clean({ label: text(b.label, `${path}.label`, CARD_LIMITS.label), tone: maybe(b.tone, (t) => pick(t, `${path}.tone`, CARD_TONES)) });
}

export function safeCardUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function action(v: unknown, path: string): CardAction {
  if (!isObj(v)) return fail(path, "must be an object");
  if (v.kind === "fill") {
    const a = obj(v, path, ["kind", "prompt"]);
    return { kind: "fill", prompt: text(a.prompt, `${path}.prompt`, CARD_LIMITS.body) };
  }
  if (v.kind === "link") {
    const a = obj(v, path, ["kind", "url"]);
    const url = safeCardUrl(text(a.url, `${path}.url`, 2000));
    return url ? { kind: "link", url } : fail(`${path}.url`, "must be an http or https address");
  }
  return fail(`${path}.kind`, 'must be "fill" (puts a prompt in the composer) or "link" (opens an http or https address)');
}

function children(v: unknown, path: string): string[] {
  return list(v, path, 1, CARD_LIMITS.nodes).map((c, i) => (typeof c === "string" && ID.test(c) ? c : fail(`${path}[${i}]`, "must be a node id")));
}

function stat(v: unknown, path: string): CardStat {
  const s = obj(v, path, ["label", "value", "change", "tone", "note", "spark"]);
  const value = typeof s.value === "number" ? num(s.value, `${path}.value`) : text(s.value, `${path}.value`, CARD_LIMITS.label);
  return clean({
    label: text(s.label, `${path}.label`, CARD_LIMITS.label),
    value,
    change: maybe(s.change, (c) => text(c, `${path}.change`, CARD_LIMITS.label)),
    tone: maybe(s.tone, (t) => pick(t, `${path}.tone`, ["good", "bad", "neutral"] as const)),
    note: maybe(s.note, (n) => text(n, `${path}.note`, 80)),
    spark: maybe(s.spark, (p) => list(p, `${path}.spark`, 2, CARD_LIMITS.spark).map((x, i) => num(x, `${path}.spark[${i}]`))),
  });
}

function field(v: unknown, path: string): CardField {
  const f = obj(v, path, ["key", "label", "as", "tones"]);
  const key = typeof f.key === "string" && KEY.test(f.key) && !RESERVED.has(f.key) ? f.key : fail(`${path}.key`, "must start with a letter and use letters, digits or underscores");
  const tones = maybe(f.tones, (t) => {
    if (!isObj(t)) return fail(`${path}.tones`, "must map cell text to a tone");
    return Object.fromEntries(Object.entries(t).slice(0, 12).map(([k, tone]) => [k, pick(tone, `${path}.tones.${k}`, CARD_TONES)]));
  });
  return clean({ key, label: maybe(f.label, (l) => text(l, `${path}.label`, CARD_LIMITS.label)), as: maybe(f.as, (a) => pick(a, `${path}.as`, ["number", "money", "date", "badge"] as const)), tones });
}

function row(v: unknown, path: string, keys: Set<string>): Record<string, CardCell> {
  const r = obj(v, path, [...keys]);
  return Object.fromEntries(Object.entries(r).map(([k, c]) => [k, c === null || typeof c === "boolean" ? c : typeof c === "number" ? num(c, `${path}.${k}`) : text(c, `${path}.${k}`)]));
}

function node(v: unknown, path: string): CardNode {
  if (!isObj(v)) return fail(path, "must be an object");
  const type = pick(v.type, `${path}.type`, CARD_TYPES);
  const n = obj(v, path, ["type", ...NODE_KEYS[type]]);
  const heading = () => maybe(n.heading, (h) => text(h, `${path}.heading`, 80));
  switch (type) {
    case "Stack":
      return clean({ type, direction: maybe(n.direction, (d) => pick(d, `${path}.direction`, ["col", "row"] as const)), gap: maybe(n.gap, (g) => pick(g, `${path}.gap`, ["sm", "md"] as const)), children: children(n.children, `${path}.children`) });
    case "Grid":
      return clean({ type, minColPx: maybe(n.minColPx, (m) => Math.min(320, Math.max(130, Math.round(num(m, `${path}.minColPx`))))), children: children(n.children, `${path}.children`) });
    case "Card":
      return clean({ type, title: text(n.title, `${path}.title`, 120), subtitle: maybe(n.subtitle, (s) => text(s, `${path}.subtitle`)), badge: maybe(n.badge, (b) => badge(b, `${path}.badge`)), children: children(n.children, `${path}.children`) });
    case "Stats":
      return clean({ type, heading: heading(), items: list(n.items, `${path}.items`, 1, CARD_LIMITS.stats).map((s, i) => stat(s, `${path}.items[${i}]`)) });
    case "Chart": {
      const as = maybe(n.as, (a) => pick(a, `${path}.as`, ["bar", "line", "donut"] as const));
      const items = list(n.items, `${path}.items`, 1, CARD_LIMITS.chart).map((x, i) => {
        const it = obj(x, `${path}.items[${i}]`, ["label", "value", "shown"]);
        return clean({ label: text(it.label, `${path}.items[${i}].label`, 24), value: num(it.value, `${path}.items[${i}].value`), shown: maybe(it.shown, (s) => text(s, `${path}.items[${i}].shown`, 24)) });
      });
      if (as === "donut" && (items.some((i) => i.value < 0) || !items.some((i) => i.value > 0))) fail(`${path}.items`, "must be zero or more with a total above zero for a donut");
      if (as !== "line" && (n.target !== undefined || n.targetLabel !== undefined)) fail(`${path}.target`, 'is only allowed when as is "line"');
      return clean({ type, as, heading: heading(), sub: maybe(n.sub, (s) => text(s, `${path}.sub`, 80)), unit: maybe(n.unit, (u) => pick(u, `${path}.unit`, ["number", "money", "percent"] as const)), items, target: maybe(n.target, (t) => num(t, `${path}.target`)), targetLabel: maybe(n.targetLabel, (t) => text(t, `${path}.targetLabel`, 24)) });
    }
    case "Table": {
      const fields = list(n.fields, `${path}.fields`, 1, CARD_LIMITS.fields).map((f, i) => field(f, `${path}.fields[${i}]`));
      const keys = new Set(fields.map((f) => f.key));
      if (keys.size !== fields.length) fail(`${path}.fields`, "must use each key once");
      return clean({ type, heading: heading(), fields, items: list(n.items, `${path}.items`, 1, CARD_LIMITS.rows).map((r, i) => row(r, `${path}.items[${i}]`, keys)) });
    }
    case "List":
      return clean({
        type,
        heading: heading(),
        items: list(n.items, `${path}.items`, 1, CARD_LIMITS.list).map((x, i) => {
          const p = `${path}.items[${i}]`;
          const it = obj(x, p, ["title", "subtitle", "meta", "badge"]);
          return clean({ title: text(it.title, `${p}.title`), subtitle: maybe(it.subtitle, (s) => text(s, `${p}.subtitle`)), meta: maybe(it.meta, (m) => text(m, `${p}.meta`, CARD_LIMITS.label)), badge: maybe(it.badge, (b) => badge(b, `${p}.badge`)) });
        }),
      });
    case "Badge":
      return { type, ...badge({ label: n.label, ...(n.tone === undefined ? {} : { tone: n.tone }) }, path) };
    case "ActionRow":
      return {
        type,
        items: list(n.items, `${path}.items`, 1, CARD_LIMITS.actions).map((x, i) => {
          const p = `${path}.items[${i}]`;
          const it = obj(x, p, ["label", "variant", "action"]);
          return clean({ label: text(it.label, `${p}.label`, CARD_LIMITS.label), variant: maybe(it.variant, (s) => pick(s, `${p}.variant`, ["primary", "secondary", "ghost"] as const)), action: action(it.action, `${p}.action`) });
        }),
      };
    case "Tabs": {
      const tabs = list(n.tabs, `${path}.tabs`, 2, CARD_LIMITS.tabs).map((x, i) => {
        const p = `${path}.tabs[${i}]`;
        const t = obj(x, p, ["id", "label", "child"]);
        const id = typeof t.id === "string" && ID.test(t.id) ? t.id : fail(`${p}.id`, "must be a short id");
        const child = typeof t.child === "string" && ID.test(t.child) ? t.child : fail(`${p}.child`, "must be a node id");
        return { id, label: text(t.label, `${p}.label`, CARD_LIMITS.label), child };
      });
      const defaultTab = maybe(n.defaultTab, (d) => (tabs.some((t) => t.id === d) ? (d as string) : fail(`${path}.defaultTab`, "must be one of the tab ids")));
      return clean({ type, defaultTab, tabs });
    }
    case "Callout":
      return clean({ type, title: maybe(n.title, (t) => text(t, `${path}.title`, 80)), body: text(n.body, `${path}.body`, CARD_LIMITS.body), tone: maybe(n.tone, (t) => pick(t, `${path}.tone`, ["info", "success", "warning", "destructive"] as const)) });
  }
}

export function childIds(n: CardNode): string[] {
  if (n.type === "Stack" || n.type === "Grid" || n.type === "Card") return n.children;
  if (n.type === "Tabs") return n.tabs.map((t) => t.child);
  return [];
}

function walk(nodes: Record<string, CardNode>, id: string, path: string[], seen: Set<string>, inCard: boolean) {
  const n = nodes[id];
  if (!n) fail(`nodes.${path[path.length - 1] ?? "root"}`, `names ${JSON.stringify(id)}, which is not in nodes`);
  if (path.includes(id)) fail(`nodes.${id}`, "is its own ancestor; the card must be a tree");
  if (seen.has(id)) fail(`nodes.${id}`, "is shown twice; give each place its own node");
  if (path.length > CARD_LIMITS.depth) fail(`nodes.${id}`, `is nested deeper than ${CARD_LIMITS.depth} levels`);
  if (n.type === "Card" && inCard) fail(`nodes.${id}`, "is a Card inside a Card; use a Stack inside the outer Card");
  seen.add(id);
  for (const c of childIds(n)) walk(nodes, c, [...path, id], seen, inCard || n.type === "Card");
}

export function readCard(raw: unknown): CardRead {
  try {
    const chars = JSON.stringify(raw ?? null).length;
    if (chars > CARD_LIMITS.chars) fail("card", `is ${chars} characters as JSON; the limit is ${CARD_LIMITS.chars}. Shorten labels or rows`);
    const c = obj(raw, "card", ["v", "title", "root", "nodes"]);
    if (c.v !== undefined && c.v !== 1) fail("card.v", "must be 1");
    const root = typeof c.root === "string" && ID.test(c.root) ? c.root : fail("card.root", "must be the id of the top node");
    if (!isObj(c.nodes)) return fail("card.nodes", "must map node ids to nodes");
    const entries = Object.entries(c.nodes);
    if (!entries.length || entries.length > CARD_LIMITS.nodes) fail("card.nodes", `must have 1 to ${CARD_LIMITS.nodes} nodes`);
    const nodes: Record<string, CardNode> = Object.create(null);
    for (const [id, v] of entries) {
      if (!ID.test(id) || RESERVED.has(id)) fail(`nodes.${id}`, "needs an id that starts with a letter and uses letters, digits, _ or -");
      nodes[id] = node(v, `nodes.${id}`);
    }
    const seen = new Set<string>();
    walk(nodes, root, [], seen, false);
    const unused = Object.keys(nodes).filter((id) => !seen.has(id));
    if (unused.length) fail(`nodes.${unused[0]}`, "is never shown; list it as a child or remove it");
    return { ok: true, card: clean({ v: 1 as const, title: maybe(c.title, (t) => text(t, "card.title", 120)), root, nodes: { ...nodes } }) };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.message };
    throw e;
  }
}

export function cardValue(value: number, unit?: CardUnit | "money" | "number"): string {
  const f = value.toLocaleString("en-US");
  return unit === "money" ? `$${f}` : unit === "percent" ? `${f}%` : f;
}

const cell = (v: CardCell | undefined, f: CardField): string => (v === null || v === undefined ? "-" : typeof v === "number" ? cardValue(v, f.as === "money" ? "money" : undefined) : String(v));

function nodeLines(card: InlineCard, id: string): string[] {
  const n = card.nodes[id];
  if (!n) return [];
  const sub = (ids: string[]) => ids.flatMap((c) => nodeLines(card, c));
  switch (n.type) {
    case "Card":
      return [n.subtitle ? `${n.title}: ${n.subtitle}` : n.title, ...sub(n.children)];
    case "Stack":
    case "Grid":
      return sub(n.children);
    case "Tabs":
      return n.tabs.flatMap((t) => [t.label, ...nodeLines(card, t.child)]);
    case "Stats":
      return [...(n.heading ? [n.heading] : []), ...n.items.map((s) => `${s.label}: ${typeof s.value === "number" ? cardValue(s.value) : s.value}${s.change ? ` (${s.change})` : ""}${s.note ? `, ${s.note}` : ""}`)];
    case "Chart":
      return [...(n.heading ? [n.heading] : []), ...(n.sub ? [n.sub] : []), ...n.items.map((i) => `${i.label} ${i.shown ?? cardValue(i.value, n.unit)}`), ...(n.target === undefined ? [] : [`${n.targetLabel ?? "Target"}: ${cardValue(n.target, n.unit)}`])];
    case "Table":
      return [...(n.heading ? [n.heading] : []), n.fields.map((f) => f.label ?? f.key).join(" · "), ...n.items.map((r) => n.fields.map((f) => cell(r[f.key], f)).join(" · "))];
    case "List":
      return [...(n.heading ? [n.heading] : []), ...n.items.map((i) => [i.title, i.subtitle, i.meta, i.badge?.label].filter(Boolean).join(" · "))];
    case "Badge":
      return [n.label];
    case "Callout":
      return [n.title ? `${n.title}: ${n.body}` : n.body];
    case "ActionRow":
      return [];
  }
}

export function cardText(card: InlineCard, limit = 1500): string {
  const t = [...(card.title ? [card.title] : []), ...nodeLines(card, card.root)].join("\n").replace(/^(?=`{3}|~{3})/gm, "\\");
  return t.length > limit ? `${t.slice(0, limit - 1).trimEnd()}…` : t;
}

export const CARD_GUIDE = `Draw a card inline in chat with chat_show. Pass card: {title?, root, nodes}, a flat map of node ids to nodes, at most ${CARD_LIMITS.nodes} nodes, ${CARD_LIMITS.depth} levels and ${CARD_LIMITS.chars} JSON characters. root names the top node; every node is shown exactly once.
Layout: Card {title, subtitle?, badge?, children} (one Card at most per branch, never a Card in a Card), Stack {direction?:"col"|"row", gap?:"sm"|"md", children}, Grid {minColPx? 130-320, children}, Tabs {defaultTab?, tabs:[{id, label, child}]} (2-5 tabs).
Data: Stats {heading?, items:[{label, value, change?, tone?:"good"|"bad"|"neutral", note?, spark?:[numbers]}]} (1-6), Chart {as?:"bar"|"line"|"donut", heading?, sub?, unit?:"number"|"money"|"percent", items:[{label, value, shown?}], target?, targetLabel?} (1-24; target only on a line; put time units in sub), Table {heading?, fields:[{key, label?, as?:"number"|"money"|"date"|"badge", tones?}], items:[rows of declared keys]} (1-4 fields, 1-20 rows), List {heading?, items:[{title, subtitle?, meta?, badge?}]} (1-20).
Text: Badge {label, tone?}, Callout {title?, body, tone?:"info"|"success"|"warning"|"destructive"}, ActionRow {items:[{label, variant?, action}]} where action is {kind:"fill", prompt} (puts a prompt in the composer) or {kind:"link", url} (http or https). Tones: ${CARD_TONES.join(", ")}.
Every node is {type, ...fields}. No HTML, scripts or images; use html_render only for a custom visual this cannot draw.`;
