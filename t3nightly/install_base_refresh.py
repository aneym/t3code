import fcntl
import json
import os
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

from . import install_live_sync as live, install_predrain as predrain
from .db_publish import wal_bytes
from .install_clone_floor import live_database
from .install_disk_room import reflinks, require
from .install_restore_copy import identity
from .io_priority import background_command
from .live_snapshot import checked_path


def note(step, **fields):
    print(json.dumps({"step": step, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields}), flush=True)


def first_base(home, root, base, size, timeout):
    source, _ = predrain.previous_copy(SimpleNamespace(home=home, backups=root), base)
    clone = reflinks(base.parent)
    if source is None:
        require(base.parent, size, "a new pre-stop base (no earlier copy; the live sync writes every page)", note)
        return {"from": None, "reflink": clone}
    if not clone:
        require(base.parent, size, "a new pre-stop base (no reflink on this filesystem)", note)
    subprocess.run(background_command(["cp", "--reflink=auto", "--sparse=always", str(source), str(base)]), stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout, check=True)
    return {"from": str(source), "reflink": clone}


def quick_check(path):
    started = time.monotonic()
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?immutable=1", uri=True)) as connection:
        result = connection.execute("PRAGMA quick_check").fetchone()[0]
    return {"quickCheck": result, "seconds": round(time.monotonic() - started, 3)}


def refresh(home, backups, *, read_bps, timeout, check=True):
    home = Path(home).expanduser().absolute()
    root = checked_path(backups, home)
    db = live_database(home)
    if not db.is_file():
        raise ValueError(f"no state database at {db}")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    started = time.monotonic()
    with predrain.base_lock(root).open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("another base refresh or install seed holds the base lock") from error
        base = root / predrain.BASE / db.name
        base.parent.mkdir(exist_ok=True, mode=0o700)
        (base.parent / "at-stop.json").unlink(missing_ok=True)
        size = db.stat().st_size + wal_bytes(db)
        created = None if base.is_file() else first_base(home, root, base, size, timeout)
        note("base-refresh-start", base=str(base), databaseBytes=size, created=created)
        pin, online = live.start(db, base, note, timeout=timeout, read_bps=read_bps)
        if pin is None:
            raise ValueError(f"live sync did not keep its read pin: {online.get('lost') or online.get('outcome')}")
        wal = live.copy_wal(pin, db, base, stopped=False)
        predrain.settle_wal(base)
        os.chmod(base, 0o600)
        observed = identity(base, copy=True)
        checked = quick_check(base) if check else {"quickCheck": "skipped"}
        if check and checked["quickCheck"] != "ok":
            raise ValueError(f"refreshed base quick_check {checked['quickCheck']}; base left unmarked")
        record = predrain.mark_base(base, {"delta": {"method": live.METHOD, "pageUpdates": online["sync"]["pagesWritten"], "seconds": online["sync"]["seconds"]}, "online": online, "wal": wal, "identity": observed, **checked})
    note("base-refresh-done", refreshSeconds=round(time.monotonic() - started, 3), **record["local"])
    return 0


def command(args):
    try:
        return refresh(args.home, args.backups, read_bps=args.refresh_read_mib_s * (1 << 20), timeout=args.offbox_copy_s * 6)
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        note("base-refresh-failed", loud=True, error=f"{type(error).__name__}: {error}"[:400])
        print(f"base refresh failed: {error}", file=sys.stderr, flush=True)
        return 1
