export const DATABASE_WORKER_SOURCE = `
const { parentPort, workerData: data } = require("node:worker_threads");
const { DatabaseSync, backup } = require("node:sqlite");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");

const flag = data.abort ? new Int32Array(data.abort) : null;
const aborted = () => flag !== null && Atomics.load(flag, 0) !== 0;
class Aborted extends Error {}
class Refused extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}
const checkAbort = () => {
  if (aborted()) throw new Aborted("aborted");
};
const one = (db, sql) => {
  const row = db.prepare(sql).get();
  return row === undefined ? null : Object.values(row)[0];
};
const tablesOf = (db, schema) =>
  new Set(db.prepare("SELECT name FROM " + schema + ".sqlite_master WHERE type = 'table'").all().map((row) => row.name));
const MIGRATION_TABLES = ["effect_sql_migrations", "aneym_fork_migrations"];
const identity = (db, schema = "main") => {
  const tables = tablesOf(db, schema);
  const migrationRows = {};
  for (const table of MIGRATION_TABLES) {
    if (tables.has(table)) migrationRows[table] = Number(one(db, "SELECT count(*) FROM " + schema + "." + table));
  }
  const events = tables.has("orchestration_events")
    ? one(db, "SELECT max(rowid) FROM " + schema + ".orchestration_events")
    : null;
  return {
    pageCount: Number(one(db, "PRAGMA " + schema + ".page_count")),
    schemaObjects: Number(one(db, "SELECT count(*) FROM " + schema + ".sqlite_master")),
    migrationRows,
    eventsMaxRowid: events === null ? null : Number(events),
  };
};
const migrations = (db, table, schema = "main") =>
  tablesOf(db, schema).has(table)
    ? db
        .prepare("SELECT migration_id AS id, name FROM " + schema + "." + table + " ORDER BY migration_id")
        .all()
        .map((row) => ({ id: Number(row.id), name: String(row.name) }))
    : [];
const size = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};
const fsyncPath = (file, flags) => {
  const fd = fs.openSync(file, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
const removeCopy = (file) => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(file + suffix, { force: true });
};
const rollback = (db) => {
  try {
    db.exec("ROLLBACK");
  } catch {}
};
const pinned = () => parentPort.postMessage({ type: "pinned" });
const released = () => parentPort.postMessage({ type: "released" });

const info = () => {
  const db = new DatabaseSync(data.live, { readOnly: true, timeout: data.lockWaitMs });
  try {
    db.exec("BEGIN");
    const tables = tablesOf(db, "main");
    const count = (table) => (tables.has(table) ? Number(one(db, "SELECT count(*) FROM " + table)) : 0);
    const current = identity(db);
    const result = {
      migrations: migrations(db, "effect_sql_migrations"),
      forkMigrations: migrations(db, "aneym_fork_migrations"),
      schemaObjects: current.schemaObjects,
      pageCount: current.pageCount,
      pageSize: Number(one(db, "PRAGMA page_size")),
      eventsMaxRowid: current.eventsMaxRowid,
      threadCount: count("orchestration_v2_projection_threads"),
      messageCount: count("orchestration_v2_projection_messages"),
      databaseBytes: size(data.live),
      walBytes: size(data.live + "-wal"),
    };
    db.exec("ROLLBACK");
    return result;
  } finally {
    db.close();
  }
};

const clone = () => {
  const flags = data.clone === "darwin" ? ["-c"] : ["--reflink=always"];
  const copy = (from, to) =>
    spawnSync("cp", [...flags, from, to], { timeout: data.cloneBudgetMs, stdio: "ignore" }).status === 0;
  const db = new DatabaseSync(data.live, { timeout: data.lockWaitMs });
  try {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw new Refused("busy", "The server's writer held the database: " + String(error && error.message));
    }
    const started = Date.now();
    pinned();
    const expected = identity(db);
    const history = migrations(db, "effect_sql_migrations");
    const cloned =
      copy(data.live, data.partial) &&
      (!fs.existsSync(data.live + "-wal") || copy(data.live + "-wal", data.partial + "-wal"));
    db.exec("ROLLBACK");
    released();
    if (!cloned) {
      removeCopy(data.partial);
      return null;
    }
    fs.chmodSync(data.partial, 0o600);
    if (fs.existsSync(data.partial + "-wal")) fs.chmodSync(data.partial + "-wal", 0o600);
    return { method: "clone", expected, history, pinnedSeconds: (Date.now() - started) / 1000 };
  } finally {
    rollback(db);
    db.close();
  }
};

const paced = async () => {
  fs.closeSync(fs.openSync(data.partial, "wx", 0o600));
  const db = new DatabaseSync(data.live, { readOnly: true, timeout: data.lockWaitMs });
  try {
    db.exec("BEGIN");
    one(db, "SELECT count(*) FROM sqlite_master");
    const started = Date.now();
    pinned();
    const expected = identity(db);
    const history = migrations(db, "effect_sql_migrations");
    checkAbort();
    await backup(db, data.partial, {
      rate: data.stepPages,
      progress: () => {
        if (aborted()) throw new Aborted("aborted");
        if (data.stepPauseMs > 0) Atomics.wait(flag, 0, 0, data.stepPauseMs);
      },
    });
    checkAbort();
    db.exec("ROLLBACK");
    released();
    return { method: "backup", expected, history, pinnedSeconds: (Date.now() - started) / 1000 };
  } finally {
    rollback(db);
    db.close();
  }
};

const verify = (copied) => {
  const db = new DatabaseSync(data.partial, { timeout: data.lockWaitMs });
  let actual;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    actual = identity(db);
  } finally {
    db.close();
  }
  checkAbort();
  if (JSON.stringify(actual) !== JSON.stringify(copied.expected)) {
    throw new Refused(
      "identity_mismatch",
      "The copy does not match the database read under the pin: " +
        JSON.stringify({ pinned: copied.expected, copy: actual }),
    );
  }
};

const keys = () => {
  fs.closeSync(fs.openSync(data.partial, "wx", 0o600));
  const db = new DatabaseSync(data.partial);
  try {
    db.prepare("ATTACH DATABASE ? AS live").run(pathToFileURL(data.live).href + "?mode=ro");
    db.exec("BEGIN");
    one(db, "SELECT count(*) FROM live.sqlite_master");
    const started = Date.now();
    pinned();
    const expected = identity(db, "live");
    const history = migrations(db, "effect_sql_migrations", "live");
    const tables = tablesOf(db, "live");
    const counts = {};
    for (const [table, key] of data.tables) {
      db.exec("CREATE TABLE main." + table + " (" + key + " TEXT PRIMARY KEY)");
      counts[table] = 0;
      if (!tables.has(table)) continue;
      const bound = db.prepare(
        "SELECT max(rowid) AS last FROM (SELECT rowid FROM live." + table + " WHERE rowid > ? ORDER BY rowid LIMIT ?)",
      );
      const copy = db.prepare(
        "INSERT INTO main." + table + " (" + key + ") SELECT " + key + " FROM live." + table + " WHERE rowid > ? AND rowid <= ?",
      );
      let last = 0;
      for (;;) {
        checkAbort();
        const next = bound.get(last, data.keysBatch).last;
        if (next === null) break;
        counts[table] += Number(copy.run(last, next).changes);
        last = next;
      }
    }
    db.exec("COMMIT");
    released();
    db.exec("DETACH DATABASE live");
    return { method: "keys", expected, history, keys: counts, pinnedSeconds: (Date.now() - started) / 1000 };
  } finally {
    rollback(db);
    db.close();
  }
};

const publish = (copied) => {
  checkAbort();
  fsyncPath(data.partial, "r+");
  fs.renameSync(data.partial, data.destination);
  fsyncPath(path.dirname(data.destination), "r");
  return { ...copied, bytes: size(data.destination) };
};

const snapshot = async () => {
  if (data.task === "keys") return publish(keys());
  let copied = data.clone === null ? null : clone();
  if (copied === null && data.clone === "darwin") {
    throw new Refused("clone_unsupported", "This volume cannot clone the database, and macOS snapshots only by clone.");
  }
  copied = copied ?? (await paced());
  verify(copied);
  return publish(copied);
};

const run = async () => {
  try {
    const result = data.task === "info" ? info() : await snapshot();
    parentPort.postMessage({ type: "done", result });
  } catch (error) {
    if (data.partial) removeCopy(data.partial);
    parentPort.postMessage({
      type: "failed",
      reason: aborted() || error instanceof Aborted ? "aborted" : error instanceof Refused ? error.reason : "error",
      message: String(error && error.message ? error.message : error),
    });
  }
};
void run();
`;
