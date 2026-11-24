// Inline worker source also runs in bundles and single-executable builds without module files.
export const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const describe = (error) => ({
  message: String(error && error.message ? error.message : error),
  code: error && error.code,
  errcode: error && error.errcode,
  errstr: error && error.errstr,
});
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: workerData.readOnly,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  // Reads the header, so a file that is not a database fails here rather than on first use.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  if (workerData.requireWal && mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", ...describe(error) });
}
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
parentPort.on("message", (request) => {
  if (request.type === "close") {
    // Closing lets SQLite checkpoint and remove the WAL, which terminating would skip.
    try {
      if (db !== undefined) db.close();
    } catch {}
    parentPort.close();
    return;
  }
  const { id, sql, params, cached, values, raw, safeIntegers } = request;
  let operation = "open";
  try {
    if (db === undefined) throw new Error("database connection is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    const started = performance.now();
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      const rows = statement.all(...params);
      parentPort.postMessage({ id, rows, ms: performance.now() - started });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage({ id, rows: raw ? result : [], ms: performance.now() - started });
    }
  } catch (error) {
    parentPort.postMessage({ id, error: { operation, ...describe(error) } });
  }
});
`;
