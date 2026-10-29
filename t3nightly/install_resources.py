import fcntl
import json
import os
import signal
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .linux_load_sample import sample as linux_sample
from .load_guard import root, signal_levels


@contextmanager
def exclusive(run, name):
    directory = Path.home() / ".t3nightly"
    directory.mkdir(exist_ok=True, mode=0o700)
    path = directory / f"{name}.lock"
    if path.is_symlink():
        raise ValueError("installer resource lock cannot be a symlink")
    with path.open("a+") as handle:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(
                f"another owner holds {name}; no additional poller started"
            ) from error
        handle.seek(0)
        handle.truncate()
        json.dump(
            {"pid": os.getpid(), "target": run.args.version, "state": str(run.state)},
            handle,
        )
        handle.flush()
        run.step("resource-owner", resource=name, pid=os.getpid())
        yield


@contextmanager
def installer_owner(run):
    def cancel(signum, frame):
        raise InterruptedError(
            "installer cancelled; old service and retained backups preserved"
        )

    prior = signal.signal(signal.SIGTERM, cancel)
    try:
        with exclusive(run, "installer"):
            yield
    finally:
        signal.signal(signal.SIGTERM, prior)


def _sample():
    path = root() / "state.json"
    if os.uname().sysname != "Linux":
        return json.loads(path.read_text())
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        data = None
    if data is not None and 0 <= time.time() - data.get("at", 0) <= 120:
        return data
    return {"at": time.time(), "sample": linux_sample(), "signals": {}, "paused": False}


def admission(run, phase):
    data = _sample()
    age = time.time() - data["at"]
    sample = data["sample"]
    levels = signal_levels(sample)
    prefixes = ("io:", "disk:", "memory", "swap", "studioext", "thermal")
    reasons = [] if 0 <= age <= 120 else ["load-guard sample is not fresh"]
    reasons += [
        key
        for key, level in levels.items()
        if key.startswith(prefixes) and level in ("soft", "hard")
    ]
    load = os.getloadavg()[0] / (os.cpu_count() or 1)
    if load > run.args.load_max:
        reasons.append(f"cpu load {load:.2f}/core exceeds {run.args.load_max}")
    if (
        sample.get("fsync_p99_ms") is None
        or sample.get("memory") in (None, "")
        or not sample.get("swap")
    ):
        reasons.append("resource sample lacks IO, memory or swap measurements")
    if sample.get("fsync_p99_ms", 0) > float(
        os.environ.get("FACTORY_STUDIO_FSYNC_P99_MS", 250)
    ):
        reasons.append("IO fsync latency exceeds load-guard budget")
    if sample.get("stuck", 0) >= int(os.environ.get("FACTORY_STUDIO_STUCK_U", 16)):
        reasons.append("IO stuck processes exceed load-guard budget")
    run.step(
        "resource-admission",
        phase=phase,
        sample_at=data["at"],
        sample_age_s=age,
        ci_paused=data.get("paused"),
        guard_signals=data.get("signals"),
        actuals={
            key: sample.get(key)
            for key in (
                "load",
                "ncpu",
                "idle",
                "memory",
                "pressure",
                "swap",
                "fsync_p99_ms",
                "stuck",
            )
        },
        blockers=reasons,
    )


def copy_snapshot(run, source, target):
    with exclusive(run, "snapshot"):
        admission(run, "snapshot")
        started = time.monotonic()
        page_size = source.execute("PRAGMA page_size").fetchone()[0]
        pages = source.execute("PRAGMA page_count").fetchone()[0]
        rate = getattr(run.args, "snapshot_mib_s", 32) * 1024**2
        deadline = getattr(run.args, "snapshot_max_s", 1200)
        if rate <= 0 or deadline <= 0:
            raise ValueError("snapshot rate and deadline must be positive")
        checked = started
        copied_pages = 0

        def progress(status, remaining, total):
            nonlocal checked, copied_pages
            if status not in (
                sqlite3.SQLITE_OK,
                sqlite3.SQLITE_DONE,
                sqlite3.SQLITE_BUSY,
                sqlite3.SQLITE_LOCKED,
            ):
                raise ValueError("snapshot backup failed")
            if status in (sqlite3.SQLITE_OK, sqlite3.SQLITE_DONE):
                if total < pages:
                    raise ValueError("snapshot source shrank during backup")
                copied_pages = total - remaining
            elapsed = time.monotonic() - started
            if elapsed >= deadline:
                raise ValueError("snapshot exceeded its time budget")
            delay = copied_pages * page_size / rate - elapsed
            if delay > 0:
                time.sleep(min(delay, deadline - elapsed))
            if time.monotonic() - started >= deadline:
                raise ValueError("snapshot exceeded its time budget")
            if time.monotonic() - checked >= 5:
                admission(run, "snapshot-progress")
                checked = time.monotonic()

        source.backup(target, pages=256, progress=progress, sleep=0.05)
        run.step(
            "snapshot-budget",
            bytes=copied_pages * page_size,
            elapsed_s=time.monotonic() - started,
            rate_bytes_s=rate,
            deadline_s=deadline,
        )
