import json
import os
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from t3nightly.install_resources import copy_snapshot
from t3nightly.install_storage import record_payload
from t3nightly.install_payload_gc import discard_snapshot, prune_backups


def refresh_snapshot(run):
    run.snapshot_ready = False
    replaced_bytes = run.snapshot.stat().st_size if run.snapshot.exists() else 0
    staged = Path(str(run.snapshot) + ".partial")
    try:
        with closing(
            sqlite3.connect(f"file:{run.db}?mode=ro", uri=True, timeout=30)
        ) as source:
            source.execute("BEGIN")
            source.execute("SELECT rootpage FROM sqlite_schema LIMIT 1").fetchone()
            with closing(sqlite3.connect(staged, timeout=30)) as target:
                copy_snapshot(run, source, target)
                target.execute("PRAGMA journal_mode=DELETE").fetchone()
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
        lifecycle="reuse-run-owned-derived-snapshot",
    )
    run.step("read-snapshot", path=str(run.snapshot), bytes=run.snapshot.stat().st_size)


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
    refresh_snapshot(run)
    if not preparing and (run.streaming_runs() or run.streaming_runs(live=True)):
        run.step(
            "backup-refused", reason="provider turns became active; nothing changed"
        )
        raise ValueError(
            "provider turns became active before the backup; nothing changed"
        )
    size = run.db.stat().st_size
    root = run.backups
    free = shutil.disk_usage(root).free
    if free < size * 2:
        raise ValueError(
            f"backup space {free >> 30} GiB under twice the {size >> 30} GiB database"
        )
    target = (
        root / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{version}"
    )
    run.payloads.hold(root, target)
    target.mkdir(mode=0o700)
    dest = target / "statev2.sqlite"
    with run.readonly() as source, closing(sqlite3.connect(dest)) as copy:
        copy_snapshot(run, source, copy)
        check = copy.execute("pragma quick_check").fetchone()[0]
    os.chmod(dest, 0o600)
    if check != "ok":
        raise ValueError(f"backup quick_check {check}")
    for extra in ("secrets", "settings.json", "restart-resume.json"):
        path = run.home / "userdata" / extra
        if path.is_file():
            shutil.copy2(path, target / extra)
    os.chmod(target, 0o700)
    marker = target / "payload.json.tmp"
    marker.write_text(json.dumps({"version": version, "complete": True}))
    os.replace(marker, target / "payload.json")
    prune_backups(root, version, run.args.backup_keep, target, run.state)
    record_payload(
        run.state,
        "rollback-backup",
        dest,
        bytes=dest.stat().st_size,
        version=version,
        quick_check=check,
    )
    run.step("backup", path=str(dest), bytes=dest.stat().st_size)
    return dest
