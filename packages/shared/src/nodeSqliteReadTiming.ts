import * as Context from "effect/Context";
import type * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

const SLOW_READ_MS = 250;

export interface ConnectionOwner {
  readonly fiberId: number;
  readonly name: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

export const connectionOwner = (fiber: Fiber.Fiber<unknown, unknown>): ConnectionOwner => {
  const current = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (current?._tag !== "Span") return { fiberId: fiber.id, name: "untraced" };
  let span: Tracer.Span = current;
  while (span.name === "sqlite" || span.name === "sql.transaction") {
    const parent: Tracer.AnySpan | undefined = Option.getOrUndefined(span.parent);
    if (parent?._tag !== "Span") break;
    span = parent;
  }
  return { fiberId: fiber.id, name: span.name, traceId: span.traceId, spanId: span.spanId };
};

export interface ReadTally {
  reads: number;
  execMs: number;
  waitMs: number;
  rows: number;
}

export const ReadTallyRef = Context.Reference<ReadTally | undefined>(
  "@t3tools/shared/nodeSqliteReadTiming/ReadTally",
  { defaultValue: () => undefined },
);

interface Hold {
  statements: number;
  execMs: number;
  rows: number;
  topMs: number;
  topSql: string;
}

export const HoldRef = Context.Reference<Hold | undefined>(
  "@t3tools/shared/nodeSqliteReadTiming/Hold",
  {
    defaultValue: () => undefined,
  },
);

export type SlowRead = Record<string, string | number>;

let sink: ((record: SlowRead) => void) | undefined;

export const onSlowRead = (next: ((record: SlowRead) => void) | undefined) => {
  sink = next;
};

const statementKind = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 240);

const round = (ms: number) => Math.round(ms * 10) / 10;

export const newHold = (): Hold => ({ statements: 0, execMs: 0, rows: 0, topMs: 0, topSql: "" });

export const noteStatement = (
  fiber: Fiber.Fiber<unknown, unknown>,
  conn: string,
  sql: string,
  rows: number,
  ms: number,
  queuedMs: number,
) => {
  const hold = fiber.getRef(HoldRef);
  if (hold !== undefined) {
    hold.statements++;
    hold.execMs += ms;
    hold.rows += rows;
    if (ms > hold.topMs) {
      hold.topMs = ms;
      hold.topSql = sql;
    }
  }
  const tally = fiber.getRef(ReadTallyRef);
  if (tally !== undefined) {
    tally.reads++;
    tally.execMs += ms;
    tally.rows += rows;
  }
  if (sink !== undefined && ms + queuedMs >= SLOW_READ_MS) {
    sink({
      k: "db.stmt",
      conn,
      owner: connectionOwner(fiber).name,
      sql: statementKind(sql),
      rows,
      ms: round(ms),
      qw: round(queuedMs),
    });
  }
};

export const noteWait = (
  fiber: Fiber.Fiber<unknown, unknown>,
  conn: string,
  ms: number,
  lane: string | undefined,
) => {
  const tally = fiber.getRef(ReadTallyRef);
  if (tally !== undefined) tally.waitMs += ms;
  if (sink !== undefined && ms >= SLOW_READ_MS) {
    sink({
      k: "db.wait",
      conn,
      ...(lane === undefined ? {} : { lane }),
      owner: connectionOwner(fiber).name,
      ms: round(ms),
    });
  }
};

export const noteHold = (
  fiber: Fiber.Fiber<unknown, unknown>,
  conn: string,
  ms: number,
  hold: Hold,
) => {
  if (sink === undefined || ms < SLOW_READ_MS || hold.statements < 2) return;
  sink({
    k: "db.hold",
    conn,
    owner: connectionOwner(fiber).name,
    ms: round(ms),
    n: hold.statements,
    exec: round(hold.execMs),
    rows: hold.rows,
    topMs: round(hold.topMs),
    top: statementKind(hold.topSql),
  });
};
