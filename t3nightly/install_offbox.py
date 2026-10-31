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
from pathlib import Path, PurePosixPath

from .install_storage import record_payload
from .io_priority import background_command

REMOTE_ROOT = PurePosixPath("/Volumes/StudioExt/t3nightly-install-data/remote")
REMOTE_EXE = "/Users/aneyman/.local/bin/sqlite3_rsync"
METHOD = "offbox-sqlite3-rsync"
LOCAL_MARGIN = 512 * 1024 * 1024
NETWORK_RATE = 20_000_000
CHECK_RATE = 100_000_000
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def target(spec):
    if sys.platform == "darwin":
        raise ValueError("--offbox is Linux only; macOS payloads already live on StudioExt")
    host, separator, raw = str(spec).partition(":")
    path = PurePosixPath(raw)
    if not separator or not NAME.fullmatch(host):
        raise ValueError("--offbox must be HOST:/absolute/path")
    if not path.is_absolute() or ".." in path.parts or path == REMOTE_ROOT or not path.is_relative_to(REMOTE_ROOT):
        raise ValueError(f"--offbox path must sit below {REMOTE_ROOT}")
    return host, path


def remote(host, script, deadline):
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", host, script], capture_output=True, text=True, timeout=max(1, deadline - time.monotonic()), check=False)
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
    script = (f"set -e; test -e {shlex.quote(str(replica))} && exit 0; newest=$(ls -1t {shlex.quote(str(root))}/*/rollback/statev2.sqlite 2>/dev/null | head -1); "
              f"[ -n \"$newest\" ] || exit 0; [ -L \"$newest\" ] && exit 0; cp -c \"$newest\" {shlex.quote(str(replica))}.seed && chmod 600 {shlex.quote(str(replica))}.seed "
              f"&& mv {shlex.quote(str(replica))}.seed {shlex.quote(str(replica))} && echo \"$newest\"")
    return remote(host, script, deadline).strip() or None


def executable():
    found = shutil.which("sqlite3_rsync") or str(Path.home() / ".local/bin/sqlite3_rsync")
    if not Path(found).is_file():
        raise ValueError("sqlite3_rsync is not installed locally")
    return found


def sync(origin, replica, deadline, *, background=False):
    command = [executable(), str(origin), str(replica), "--exe", REMOTE_EXE]
    result = subprocess.run(background_command(command) if background else command, capture_output=True, text=True, timeout=max(1, deadline - time.monotonic()), check=False)
    if result.returncode:
        raise ValueError(f"sqlite3_rsync {origin} -> {replica} failed: {result.stderr.strip()[-300:]}")


def remote_check(host, replica, deadline):
    path = shlex.quote(str(replica))
    return remote(host, f"set -e; chmod 600 {path}; sqlite3 {path} 'PRAGMA quick_check'", deadline).strip()


def local_check(path):
    with closing(sqlite3.connect(path, timeout=30, isolation_level=None)) as connection:
        check = connection.execute("PRAGMA quick_check").fetchone()[0]
        if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] != 0:
            raise ValueError("restored database WAL checkpoint is busy")
    return check


def placement(run, local):
    host, root = target(run.args.offbox)
    version = run.args.version
    if not NAME.fullmatch(version):
        raise ValueError("invalid rollback version path")
    replica = root / version / "rollback" / "statev2.sqlite"
    source = run.db.resolve()
    size = sum(path.stat().st_size for path in (source, Path(str(source) + "-wal")) if path.exists())
    deadline = time.monotonic() + 120 + size / NETWORK_RATE
    if shutil.disk_usage(local).free < LOCAL_MARGIN:
        raise ValueError("insufficient local margin for an off-box rollback backup")
    if remote_directory(host, replica.parent, deadline) < max(size * 2, LOCAL_MARGIN):
        raise ValueError("insufficient off-box rollback backup disk space")
    return host, root, replica, source, size, deadline


def preseed(run, host, root, replica, source, deadline, started):
    address = f"{host}:{replica}"
    seeded = {"clonedFrom": seed(host, root, replica, deadline)}
    sync(source, address, deadline, background=True)
    seeded["seconds"] = round(time.monotonic() - started, 3)
    run.step("hard-backup-seed", remote=address, **seeded)
    return seeded


def verified(run, host, root, replica, deadline, metadata):
    check = remote_check(host, replica, deadline)
    if check != "ok":
        raise ValueError(f"off-box backup quick_check {check}")
    metadata = {"remote": f"{host}:{replica}", "method": METHOD, "quickCheck": check, **metadata, "complete": True}
    record_payload(run.state, "rollback-backup", metadata["remote"], bytes=metadata["bytes"], method=METHOD, quick_check=check)
    return metadata


def live_backup(run, previous):
    started = time.monotonic()
    host, root, replica, source, size, deadline = placement(run, run.db.resolve().parent)
    seeded = preseed(run, host, root, replica, source, deadline, started)
    metadata = verified(run, host, root, replica, deadline + size / CHECK_RATE, {"bytes": size, "seed": seeded, "live": True, "previous": previous})
    metadata["seconds"] = round(time.monotonic() - started, 3)
    run.step("backup", **metadata)
    prune(run, host, root, run.args.version)
    return metadata


def capture(run, previous, stop, rollback_gate):
    started = time.monotonic()
    local = run.home / "runtime" / "rollback"
    local.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = local / uuid.uuid4().hex
    destination.mkdir(mode=0o700)
    host, root, replica, source, size, deadline = placement(run, local)
    seeded = None if rollback_gate() else preseed(run, host, root, replica, source, deadline, started)
    binary = rollback_gate()
    stop()
    if binary:
        metadata = {"method": "binary-rollback", **binary, "seconds": round(time.monotonic() - started, 3), "previous": previous, "complete": True}
        destination.rmdir()
        run.step("hard-backup", **metadata)
        return metadata
    stopped = time.monotonic()
    deadline = stopped + 120 + size / NETWORK_RATE + size / CHECK_RATE
    sync(source, f"{host}:{replica}", deadline)
    metadata = verified(run, host, root, replica, deadline, {"bytes": size, "seed": seeded, "stoppedSeconds": round(time.monotonic() - stopped, 3), "seconds": round(time.monotonic() - started, 3), "previous": previous})
    (destination / "payload.json").write_text(json.dumps(metadata))
    run.step("hard-backup", **metadata)
    prune(run, host, root, run.args.version)
    return metadata


def prune(run, host, root, current):
    listed = remote(host, f"cd {shlex.quote(str(root))} && ls -1t */rollback/statev2.sqlite 2>/dev/null || true", time.monotonic() + 60)
    names = [line.split("/")[0] for line in listed.splitlines() if NAME.fullmatch(line.split("/")[0])]
    for name in [name for name in names if name != current][max(run.args.backup_keep - 1, 0):]:
        path = shlex.quote(str(root / name))
        remote(host, f"set -e; [ ! -L {path} ]; rm -rf -- {path}", time.monotonic() + 120)
        record_payload(run.state, "discard-offbox-rollback-backup", f"{host}:{root / name}", bytes=0)


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
    deadline = time.monotonic() + 120 + size / NETWORK_RATE + size / CHECK_RATE
    if beside is None:
        beside = shutil.disk_usage(db.parent).free >= max(size * 2, LOCAL_MARGIN)
    if beside:
        staged = db.with_name(f".{db.name}.restore-{uuid.uuid4().hex}")
        try:
            sync(address, staged, deadline)
            check = local_check(staged)
            if check != "ok":
                raise ValueError(f"restored database quick_check {check}")
            os.chmod(staged, db.stat().st_mode & 0o777 if db.exists() else 0o600)
            for suffix in ("-wal", "-shm"):
                Path(f"{db}{suffix}").unlink(missing_ok=True)
            os.replace(staged, db)
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
