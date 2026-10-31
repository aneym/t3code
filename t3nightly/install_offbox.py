import hashlib
import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from .install_storage import record_payload
from .io_priority import background_command

REMOTE_ROOT = PurePosixPath("/Volumes/StudioExt/t3nightly-install-data/remote")
REMOTE_EXE = "/Users/aneyman/.local/bin/sqlite3_rsync"
SSH = Path(__file__).with_name("offbox-ssh")
METHOD = "offbox-sqlite3-rsync"
LOCAL_MARGIN = 512 * 1024 * 1024
CATCH_UP_ROUNDS = 3
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def target(spec):
    if sys.platform == "darwin":
        raise ValueError("--offbox is Linux only; macOS payloads already live on StudioExt")
    host, separator, raw = str(spec).partition(":")
    path = PurePosixPath(raw)
    if not separator or not NAME.fullmatch(host):
        raise ValueError("--offbox must be HOST:/absolute/path")
    if not path.is_absolute() or path == REMOTE_ROOT or not path.is_relative_to(REMOTE_ROOT):
        raise ValueError(f"--offbox path must sit below {REMOTE_ROOT}")
    if not all(NAME.fullmatch(part) and part not in (".", "..") for part in path.relative_to(REMOTE_ROOT).parts):
        raise ValueError("--offbox path components must be letters, digits, dot, dash or underscore")
    return host, path


def remote(host, script, deadline):
    result = subprocess.run([str(SSH), host, script], capture_output=True, text=True, timeout=max(1, deadline - time.monotonic()), check=False)
    if result.returncode:
        raise ValueError(f"off-box command on {host} failed: {result.stderr.strip()[-300:]}")
    return result.stdout


def remote_directory(host, path, deadline):
    parts = path.relative_to(REMOTE_ROOT).parts
    chain = " ".join(shlex.quote(str(REMOTE_ROOT.joinpath(*parts[:index]))) for index in range(len(parts) + 1))
    script = (f"set -e; umask 077; test -d {shlex.quote(str(REMOTE_ROOT.parent))}; for p in {chain}; do "
              f"if [ -L \"$p\" ]; then echo \"payload directory is a symlink: $p\" >&2; exit 3; fi; [ -d \"$p\" ] || mkdir -m 700 \"$p\"; chmod 700 \"$p\"; done; "
              f"df -Pk {shlex.quote(str(path))} | tail -1")
    return int(remote(host, script, deadline).split()[3]) * 1024


def seed(host, root, replica, deadline):
    path = shlex.quote(str(replica))
    script = (f"set -e; test -e {path} && exit 0; newest=$(ls -1t {shlex.quote(str(root))}/*/rollback/statev2.sqlite 2>/dev/null | head -1); "
              f"[ -n \"$newest\" ] || exit 0; [ -L \"$newest\" ] && exit 0; cp -c \"$newest\" {path}.seed && chmod 600 {path}.seed "
              f"&& mv {path}.seed {path} && echo \"$newest\"")
    return remote(host, script, deadline).strip() or None


def executable():
    found = shutil.which("sqlite3_rsync") or str(Path.home() / ".local/bin/sqlite3_rsync")
    if not Path(found).is_file():
        raise ValueError("sqlite3_rsync is not installed locally")
    return found


def sync(origin, replica, deadline, *, background=False):
    command = [executable(), str(origin), str(replica), "--exe", REMOTE_EXE, "--ssh", str(SSH)]
    started = time.monotonic()
    result = subprocess.run(background_command(command) if background else command, capture_output=True, text=True, timeout=max(1, deadline - time.monotonic()), check=False)
    if result.returncode:
        raise ValueError(f"sqlite3_rsync {origin} -> {replica} failed: {result.stderr.strip()[-300:]}")
    return time.monotonic() - started


def remote_check(host, replica, deadline):
    path = shlex.quote(str(replica))
    return remote(host, f"set -e; chmod 600 {path}; sqlite3 {path} 'PRAGMA quick_check'", deadline).strip()


def local_check(path):
    with closing(sqlite3.connect(path, timeout=30, isolation_level=None)) as connection:
        check = connection.execute("PRAGMA quick_check").fetchone()[0]
        if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] != 0:
            raise ValueError("database WAL checkpoint is busy")
    return check


def schema_state(db):
    with closing(sqlite3.connect(f"{Path(db).resolve().as_uri()}?mode=ro", uri=True, timeout=30)) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        rows = [connection.execute("SELECT type, name, coalesce(sql, '') FROM sqlite_master ORDER BY type, name").fetchall()]
        rows += [connection.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall() for table in ("effect_sql_migrations", "aneym_fork_migrations") if table in tables]
    return hashlib.sha256(json.dumps(rows, default=str).encode()).hexdigest()


def wal_bytes(db):
    wal = Path(f"{db}-wal")
    return wal.stat().st_size if wal.exists() else 0


def restore_space(size, wal):
    return max(LOCAL_MARGIN, size // 4, wal * 2)


def rate(run):
    return run.args.offbox_mib_s * 1024 * 1024


def placement(run, local):
    host, root = target(run.args.offbox)
    version = run.args.version
    if not NAME.fullmatch(version):
        raise ValueError("invalid rollback version path")
    replica = root / version / "rollback" / "statev2.sqlite"
    source = run.db.resolve()
    size = source.stat().st_size + wal_bytes(source)
    if shutil.disk_usage(local).free < LOCAL_MARGIN:
        raise ValueError("insufficient local margin for an off-box rollback backup")
    if remote_directory(host, replica.parent, time.monotonic() + 120) < max(size * 2, LOCAL_MARGIN):
        raise ValueError("insufficient off-box rollback backup disk space")
    return host, root, replica, source, size


def preseed(run, host, root, replica, source, started):
    address = f"{host}:{replica}"
    deadline = time.monotonic() + run.args.offbox_seed_s
    seeded = {"clonedFrom": seed(host, root, replica, deadline)}
    sync(source, address, deadline, background=True)
    seeded["seconds"] = round(time.monotonic() - started, 3)
    run.step("hard-backup-seed", remote=address, **seeded)
    return seeded, deadline


def verified(run, host, root, replica, deadline, metadata):
    check = remote_check(host, replica, deadline)
    if check != "ok":
        raise ValueError(f"off-box backup quick_check {check}")
    metadata = {"remote": f"{host}:{replica}", "method": METHOD, "quickCheck": check, **metadata, "complete": True}
    marker = json.dumps({"verifiedAt": datetime.now(timezone.utc).isoformat(), "quickCheck": check, "bytes": metadata["bytes"], "schemaState": metadata.get("schemaState")})
    path = shlex.quote(str(replica.parent / "verified.json"))
    remote(host, f"set -e; umask 077; printf '%s\\n' {shlex.quote(marker)} > {path}.tmp && mv {path}.tmp {path}", deadline)
    record_payload(run.state, "rollback-backup", metadata["remote"], bytes=metadata["bytes"], method=METHOD, quick_check=check)
    return metadata


def live_backup(run, previous):
    started = time.monotonic()
    host, root, replica, source, size = placement(run, run.db.resolve().parent)
    seeded, deadline = preseed(run, host, root, replica, source, started)
    metadata = verified(run, host, root, replica, deadline, {"bytes": size, "seed": seeded, "live": True, "previous": previous})
    metadata["seconds"] = round(time.monotonic() - started, 3)
    run.step("backup", **metadata)
    prune(run, host, root, run.args.version)
    return metadata


def catch_up(run, host, replica, source, size, deadline):
    started = time.monotonic()
    check = remote_check(host, replica, deadline)
    if check != "ok":
        raise ValueError(f"seeded off-box replica quick_check {check}; nothing stopped")
    checking = time.monotonic() - started
    budget = run.args.offbox_stop_s
    for _ in range(CATCH_UP_ROUNDS):
        last = sync(source, f"{host}:{replica}", deadline, background=True)
        estimate = max(last, wal_bytes(source) / rate(run)) + checking
        if estimate <= budget / 2:
            break
    run.step("hard-backup-estimate", catchUpSeconds=round(last, 3), checkSeconds=round(checking, 3), estimateSeconds=round(estimate, 3), budgetSeconds=budget)
    if estimate > budget:
        raise ValueError(f"post-stop off-box sync estimated at {estimate:.0f} s exceeds --offbox-stop-s {budget}; nothing stopped")
    needed = restore_space(size, wal_bytes(source))
    if shutil.disk_usage(source.parent).free < needed:
        raise ValueError(f"local space under the {needed >> 20} MiB an in-place restore could need; nothing stopped")


def capture(run, previous, stop, rollback_gate):
    started = time.monotonic()
    binary = rollback_gate()
    if binary:
        stop()
        metadata = {"method": "binary-rollback", **binary, "seconds": round(time.monotonic() - started, 3), "previous": previous, "complete": True}
        run.step("hard-backup", **metadata)
        return metadata
    local = run.home / "runtime" / "rollback"
    local.mkdir(parents=True, exist_ok=True, mode=0o700)
    host, root, replica, source, size = placement(run, local)
    seeded, deadline = preseed(run, host, root, replica, source, started)
    catch_up(run, host, replica, source, size, deadline)
    destination = local / uuid.uuid4().hex
    destination.mkdir(mode=0o700)
    stop()
    stopped = time.monotonic()
    deadline = stopped + run.args.offbox_stop_s
    state = schema_state(source)
    sync(source, f"{host}:{replica}", deadline)
    metadata = verified(run, host, root, replica, deadline, {"bytes": size, "schemaState": state, "seed": seeded, "stoppedSeconds": round(time.monotonic() - stopped, 3),
                                                             "seconds": round(time.monotonic() - started, 3), "previous": previous})
    (destination / "payload.json").write_text(json.dumps(metadata))
    run.step("hard-backup", **metadata)
    return metadata


def prune_backup(run, backup):
    host, _, path = backup["remote"].partition(":")
    prune(run, host, PurePosixPath(path).parent.parent.parent, run.args.version)


def prune(run, host, root, current):
    try:
        listed = remote(host, f"cd {shlex.quote(str(root))} && ls -1t */rollback/verified.json 2>/dev/null || true", time.monotonic() + 60)
        names = [line.split("/")[0] for line in listed.splitlines() if NAME.fullmatch(line.split("/")[0])]
        for name in [name for name in names if name != current][max(run.args.backup_keep - 1, 0):]:
            path = shlex.quote(str(root / name))
            remote(host, f"set -e; [ ! -L {path} ]; rm -rf -- {path}", time.monotonic() + 120)
            record_payload(run.state, "discard-offbox-rollback-backup", f"{host}:{root / name}", bytes=0)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        run.step("offbox-prune-failed", error=str(error))


def fsync(path, flags=os.O_RDONLY):
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish(staged, db):
    wal = Path(f"{db}-wal")
    try:
        local_check(db)
    except (sqlite3.Error, ValueError):
        pass
    if wal_bytes(db):
        wal.unlink()
        Path(f"{db}-shm").unlink(missing_ok=True)
    for suffix in ("-wal", "-shm"):
        Path(f"{staged}{suffix}").unlink(missing_ok=True)
    fsync(staged)
    os.replace(staged, db)
    fsync(db.parent)
    wal.unlink(missing_ok=True)
    Path(f"{db}-shm").unlink(missing_ok=True)
    fsync(db.parent)


def restore(run, backup, *, beside=None):
    started = time.monotonic()
    host, _, raw = backup["remote"].partition(":")
    replica = PurePosixPath(raw)
    if replica.name != "statev2.sqlite":
        raise ValueError("off-box backup must name a statev2.sqlite replica")
    target(f"{host}:{replica.parent}")
    address = backup["remote"]
    db = run.db.resolve()
    size = int(backup["bytes"])
    budget = run.args.offbox_seed_s
    free = shutil.disk_usage(db.parent).free
    if beside is None:
        beside = free >= max(size * 2, LOCAL_MARGIN) and size / rate(run) <= budget
    if not beside and free < restore_space(size, wal_bytes(db)):
        raise ValueError("insufficient local space for an in-place off-box restore")
    deadline = time.monotonic() + budget
    if beside:
        staged = db.with_name(f".{db.name}.restore-{uuid.uuid4().hex}")
        try:
            sync(address, staged, deadline)
            check = local_check(staged)
            if check != "ok":
                raise ValueError(f"restored database quick_check {check}")
            os.chmod(staged, db.stat().st_mode & 0o777 if db.exists() else 0o600)
            publish(staged, db)
        finally:
            for suffix in ("", "-wal", "-shm", "-journal"):
                Path(f"{staged}{suffix}").unlink(missing_ok=True)
    else:
        sync(address, db, deadline)
        check = local_check(db)
        if check != "ok":
            raise ValueError(f"restored database quick_check {check}")
    metadata = {"remote": address, "into": "beside" if beside else "in-place", "quickCheck": check, "seconds": round(time.monotonic() - started, 3)}
    run.step("hard-restore-db", **metadata)
    return metadata


def unchanged(run, backup):
    try:
        return schema_state(run.db) == backup.get("schemaState") and local_check(run.db.resolve()) == "ok"
    except (OSError, sqlite3.Error, ValueError):
        return False


def rollback_database(run, backup):
    if unchanged(run, backup):
        run.step("hard-restore-db-skipped", reason="schema and migrations match the backup")
        return
    try:
        restore(run, backup)
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        intact = unchanged(run, backup)
        run.step("hard-restore-db-failed", error=str(error), databaseUnchanged=intact)
        if not intact:
            raise
