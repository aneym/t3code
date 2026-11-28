import { memo } from "react";
import { type CardField, type CardNode, type CardTone, type CardUnit, cardValue } from "./inline-card";

type Of<T extends CardNode["type"]> = Extract<CardNode, { type: T }>;

export const toneClass = (tone: CardTone | undefined) => `rk-tone-${tone ?? "neutral"}`;

const PALETTE = ["var(--chart-1, var(--primary))", "var(--chart-2, var(--info))", "var(--chart-3, var(--success))", "var(--chart-4, var(--warning))", "var(--chart-5, var(--muted-foreground))"];

function Heading({ heading, sub }: { heading?: string | undefined; sub?: string | undefined }) {
  if (!heading && !sub) return null;
  return (
    <div className="rk-head">
      {heading && <h4 className="rk-heading">{heading}</h4>}
      {sub && <span className="rk-sub">{sub}</span>}
    </div>
  );
}

function Spark({ data }: { data: number[] }) {
  const min = Math.min(...data);
  const span = Math.max(...data) - min || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * 44).toFixed(1)},${(16 - ((v - min) / span) * 14).toFixed(1)}`).join(" ");
  return (
    <svg className="rk-spark" width="44" height="18" viewBox="0 0 44 18" aria-hidden="true">
      <polyline fill="none" stroke={PALETTE[0]} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={pts} />
    </svg>
  );
}

export const StatsView = memo(function StatsView({ node }: { node: Of<"Stats"> }) {
  return (
    <section className="rk-block">
      <Heading heading={node.heading} />
      <div className="rk-stats">
        {node.items.map((it, i) => (
          <div key={i} className="rk-stat">
            <div className="rk-stat-label">{it.label}</div>
            <div className="rk-stat-row">
              <span className="rk-stat-value">{typeof it.value === "number" ? cardValue(it.value) : it.value}</span>
              {it.spark && <Spark data={it.spark} />}
            </div>
            {(it.change || it.note) && (
              <div className="rk-stat-meta">
                {it.change && <span className={`rk-delta-${it.tone ?? "neutral"}`}>{it.change}</span>}
                {it.note && <span className="rk-muted">{it.note}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
});

function LineChart({ node }: { node: Of<"Chart"> }) {
  const w = 480;
  const h = 136;
  const pad = 12;
  const vals = node.items.map((i) => i.value).concat(node.target === undefined ? [] : [node.target]);
  const min = Math.min(...vals);
  const span = Math.max(...vals) - min || 1;
  const n = node.items.length;
  const x = (i: number) => pad + (n === 1 ? (w - pad * 2) / 2 : (i / (n - 1)) * (w - pad * 2));
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const d = node.items.map((it, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(it.value).toFixed(1)}`).join(" ");
  const first = node.items[0];
  const last = node.items[n - 1];
  if (!first || !last) return null;
  return (
    <div className="rk-block">
      <svg className="rk-line" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${node.heading ?? "Line chart"}: ${first.label} ${first.shown ?? cardValue(first.value, node.unit)} to ${last.label} ${last.shown ?? cardValue(last.value, node.unit)}`}>
        {node.target !== undefined && <line x1={pad} x2={w - pad} y1={y(node.target)} y2={y(node.target)} stroke="var(--muted-foreground)" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        <path d={d} fill="none" stroke={PALETTE[0]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="rk-axis">
        <span>{first.label} · {first.shown ?? cardValue(first.value, node.unit)}</span>
        {node.target !== undefined && <span>{node.targetLabel ?? "Target"}: {cardValue(node.target, node.unit)}</span>}
        {n > 1 && <span>{last.label} · {last.shown ?? cardValue(last.value, node.unit)}</span>}
      </div>
    </div>
  );
}

function Donut({ node }: { node: Of<"Chart"> }) {
  const total = node.items.reduce((a, b) => a + b.value, 0) || 1;
  const c = 2 * Math.PI * 34;
  const arcs: { len: number; start: number }[] = [];
  let run = 0;
  for (const it of node.items) {
    const len = (it.value / total) * c;
    arcs.push({ len, start: run });
    run += len;
  }
  return (
    <div className="rk-donut">
      <svg width="92" height="92" viewBox="0 0 92 92" aria-hidden="true">
        {arcs.map(({ len, start }, i) => (
          <circle key={i} cx="46" cy="46" r="34" fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="12" strokeDasharray={`${len.toFixed(1)} ${(c - len).toFixed(1)}`} strokeDashoffset={(-start).toFixed(1)} transform="rotate(-90 46 46)" />
        ))}
      </svg>
      <div className="rk-legend">
        {node.items.map((it, i) => (
          <div key={i} className="rk-legend-row">
            <span className="rk-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="rk-legend-label">{it.label}</span>
            <span className="rk-num">{it.shown ?? cardValue(it.value, node.unit)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Bars({ node }: { node: Of<"Chart"> }) {
  const max = Math.max(1, ...node.items.map((i) => Math.abs(i.value)));
  return (
    <div className="rk-bars">
      {node.items.map((it, i) => (
        <div key={i} className="rk-bar-row">
          <span className="rk-bar-label">{it.label}</span>
          <div className="rk-bar-track">
            <div className="rk-bar-fill" style={{ width: `${Math.max(2, (Math.max(0, it.value) / max) * 100).toFixed(1)}%` }} />
          </div>
          <span className="rk-num">{it.shown ?? cardValue(it.value, node.unit as CardUnit)}</span>
        </div>
      ))}
    </div>
  );
}

export const ChartView = memo(function ChartView({ node }: { node: Of<"Chart"> }) {
  return (
    <section className="rk-block">
      <Heading heading={node.heading} sub={node.sub} />
      {node.as === "line" ? <LineChart node={node} /> : node.as === "donut" ? <Donut node={node} /> : <Bars node={node} />}
    </section>
  );
});

const numeric = (f: CardField) => f.as === "number" || f.as === "money";

export const TableView = memo(function TableView({ node }: { node: Of<"Table"> }) {
  return (
    <section className="rk-block">
      <Heading heading={node.heading} />
      <div className="rk-table-wrap">
        <table className="rk-table">
          <thead>
            <tr>
              {node.fields.map((f) => (
                <th key={f.key} className={numeric(f) ? "rk-num" : undefined}>{f.label ?? f.key}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.items.map((row, r) => (
              <tr key={r}>
                {node.fields.map((f) => {
                  const v = row[f.key];
                  const shown = v === null || v === undefined ? "-" : typeof v === "number" ? cardValue(v, f.as === "money" ? "money" : undefined) : String(v);
                  return (
                    <td key={f.key} data-label={f.label ?? f.key} className={numeric(f) ? "rk-num" : undefined}>
                      {f.as === "badge" ? <span className={`rk-badge ${toneClass(f.tones?.[shown])}`}>{shown}</span> : shown}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
});

export const ListView = memo(function ListView({ node }: { node: Of<"List"> }) {
  return (
    <section className="rk-block">
      <Heading heading={node.heading} />
      <ul className="rk-list">
        {node.items.map((it, i) => (
          <li key={i} className="rk-list-row">
            <div className="rk-list-main">
              <div className="rk-list-title">{it.title}</div>
              {it.subtitle && <div className="rk-muted">{it.subtitle}</div>}
            </div>
            {(it.meta || it.badge) && (
              <div className="rk-list-side">
                {it.meta && <span className="rk-muted rk-num">{it.meta}</span>}
                {it.badge && <span className={`rk-badge ${toneClass(it.badge.tone)}`}>{it.badge.label}</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
});
