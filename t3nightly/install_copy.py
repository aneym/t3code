import json
import os
import shutil
import sqlite3
import subprocess
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from t3nightly.install_resources import copy_snapshot
from t3nightly.install_storage import record_payload
from t3nightly.install_payload_gc import discard_snapshot
from t3nightly.live_snapshot import snapshot_root, take
from t3nightly.snapshot_clone import clone_file
from t3nightly.snapshot_space import clone_supported, require_install_space, require_space


def refresh_snapshot(run):
    if getattr(run.args, "offbox", ""):
        raise ValueError("--offbox never takes a live read snapshot; nothing stopped")
    started = time.monotonic()
    run.snapshot_ready = False
    replaced_bytes = run.snapshot.stat().st_size if run.snapshot.exists() else 0
    staged = Path(str(run.snapshot) + ".partial")
    try:
        take(staged, home=run.home, timeout=getattr(run.args, "snapshot_max_s", 1200))
        os.chmod(staged, 0o600)
        os.replace(staged, run.snapshot)
    finally:
        discard_snapshot(
            run.snapshots, staged, run.state, "discard-incomplete-derived-snapshot"
        )
    run.snapshot_ready = True
    record_payload(
        run.state,
        "read-snapshot",
        run.snapshot,
        bytes=run.snapshot.stat().st_size,
        source=str(run.db),
        replaced_bytes=replaced_bytes,
        lifecycle="fresh-install-owned-derived-snapshot",
    )
    run.step("read-snapshot", path=str(run.snapshot), bytes=run.snapshot.stat().st_size, elapsed_s=round(time.monotonic() - started, 3))


def backup_database(run, version, *, preparing=False):
    if not version or Path(version).name != version or version in (".", ".."):
        raise ValueError("invalid rollback version path")
    if not preparing and run.streaming_runs(live=True):
        run.step(
            "backup-refused", reason="provider turns became active; nothing changed"
        )
        raise ValueError(
            "provider turns became active before the backup; nothing changed"
        )
    root = run.backups
    if getattr(run.args, "offbox", ""):
        raise ValueError("offbox install must use the offbox backup path; nothing stopped")
    require_install_space(run.db, snapshot_root(run.home), run.snapshots, root)
    refresh_snapshot(run)
    if not preparing and (run.streaming_runs() or run.streaming_runs(live=True)):
        run.step(
            "backup-refused", reason="provider turns became active; nothing changed"
        )
        raise ValueError(
            "provider turns became active before the backup; nothing changed"
        )
    require_space(root, run.snapshot.stat().st_size, clone=clone_supported(run.snapshot.parent, root))
    target = (
        root / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{version}"
    )
    run.payloads.hold(root, target)
    target.mkdir(mode=0o700)
    dest = target / "statev2.sqlite"
    started = time.monotonic()
    with run.readonly() as source:
        try:
            clone_file(run.snapshot, dest, getattr(run.args, "snapshot_max_s", 1200))
            method = "clone"
        except (OSError, subprocess.SubprocessError) as error:
            dest.unlink(missing_ok=True)
            run.step("backup-clone-unavailable", reason=f"{type(error).__name__}: {error}")
            require_space(root, run.snapshot.stat().st_size)
            with closing(sqlite3.connect(dest)) as copy:
                copy_snapshot(run, source, copy)
            method = "sqlite-backup"
    copied = time.monotonic()
    with closing(sqlite3.connect(dest.as_uri() + "?mode=ro", uri=True)) as copy:
        check = copy.execute("pragma quick_check").fetchone()[0]
    for suffix in ("-wal", "-shm"):
        Path(str(dest) + suffix).unlink(missing_ok=True)
    os.chmod(dest, 0o600)
    if check != "ok":
        raise ValueError(f"backup quick_check {check}")
    for extra in ("secrets", "settings.json", "restart-resume.json"):
        path = run.home / "userdata" / extra
        if path.is_file():
            shutil.copy2(path, target / extra)
    os.chmod(target, 0o700)
    marker = target / "payload.json.tmp"
    home = str(run.home.resolve())
    marker.write_text(json.dumps({"version": version, "complete": True, "home": home, "method": method}))
    os.replace(marker, target / "payload.json")
    record_payload(
        run.state,
        "rollback-backup",
        dest,
        bytes=dest.stat().st_size,
        version=version,
        quick_check=check,
        method=method,
    )
    run.step("backup", path=str(dest), bytes=dest.stat().st_size, method=method, copy_s=round(copied - started, 3), quick_check_s=round(time.monotonic() - copied, 3))
    from .install_backup_retention import mark
    try:
        mark(dest, {"method": method, "previous": version}, run.home)
    except Exception as error:
        run.report["backupMarkError"] = {"path": str(dest), "error": f"{type(error).__name__}: {error}"}
        run.step("backup-mark", **run.report["backupMarkError"])
    return dest
