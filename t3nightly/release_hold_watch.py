import fcntl
from contextlib import closing
import json
import os
import shlex
import signal
import sqlite3
import subprocess
import time
from pathlib import Path

from .release_hold_quarantine import add_quarantine, clear_quarantine, pending
from .release_hold_state import event, read, save, snapshot, terminal
from .release_timeline import utc_now

SUFFIX = {"studio": "M", "owl": "O", "forge": "F", "ax42": "L"}


def lead_snapshot(config, row):
    if config["host"] == "studio":
        return snapshot(read(Path(config["sourceRun"]) / "release-holds/source.json"), config["host"], row)
    argv = [config["sourcePython"], "-B", config["sourceTools"] + "/release-holds",
            "snapshot", config["sourceRun"], config["host"]]
    result = subprocess.run(["ssh", "-oBatchMode=yes", "-oConnectTimeout=5", config["leadHost"], shlex.join(argv)],
                            input=json.dumps(row), capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


def secret_parked(config, root):
    try:
        if config["sandbox"]:
            requests = read(root / "secret-parked.json", {"requests": []})["requests"]
        else:
            database = Path.home() / ".t3/userdata/statev2.sqlite"
            with closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2)) as connection:
                deadline = time.monotonic() + 5
                connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
                requests = [{"threadId": thread, "runId": run} for thread, run in connection.execute(
                    "SELECT DISTINCT r.thread_id, r.run_id FROM orchestration_v2_projection_runs r "
                    "CROSS JOIN orchestration_v2_projection_turn_items i ON i.run_id = r.run_id "
                    "WHERE r.status IN ('queued','preparing','starting','running','waiting') "
                    "AND i.type = 'secret_request' AND i.status = 'waiting'").fetchall()]
        event(root, "secret-check", secretParked=len(requests), requests=requests, warning=bool(requests))
    except (OSError, ValueError, KeyError, sqlite3.Error):
        event(root, "secret-check", warning=True, unavailable=True)


def release(config, root, row, reason):
    (root / f"{config['host']}.ready").unlink(missing_ok=True)
    if row.get("released"):
        (root / f"{config['host']}.stop").touch()
        save(root, row, ready=False)
        return
    secret_parked(config, root)
    save(root, row, outcome="released", released=utc_now(), ready=False, releaseReason=reason)
    (root / f"{config['host']}.stop").touch()
    event(root, "released", reason=reason)


def policy(config, root, row, observed):
    done = set(observed["scheduler"].get("done", []))
    failed = set(observed["scheduler"].get("failed", []))
    proofs = {prefix + SUFFIX[config["host"]] for prefix in "REX"}
    if proofs & failed or (config["host"] == "ax42" and "TL" in failed):
        (root / f"{config['host']}.ready").unlink(missing_ok=True)
        if row.get("outcome") != "proofs-failed":
            save(root, row, outcome="proofs-failed", ready=False)
            event(root, "proofs-failed")
    elif row.get("outcome") != "proofs-failed" and proofs <= done and observed["gate"]:
        if config["host"] == "ax42":
            if not row.get("ready"):
                (root / "ax42.ready").touch()
                save(root, row, outcome="ready-manual", ready=True, readyAt=utc_now(),
                     next="Factory pause and disk-mover hold, then manual release")
                event(root, "ready-manual")
        elif config["host"] == "forge":
            add_quarantine(config, root, row)
            if row.get("quarantineAt") and time.time() >= row["quarantineAt"] + config["quarantineSeconds"]:
                release(config, root, row, "proofs-passed")
        else:
            release(config, root, row, "proofs-passed")


def exit_worker(signum, frame):
    raise SystemExit(1)


def worker(root, lock_fd):
    root = Path(root).resolve()
    config = read(root / "config.json")
    with (root / "worker.lock").open("a") as owner:
        try:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        row = read(root / "state.json", {"outcome": "waiting-lock", "host": config["host"]})
        save(root, row, pid=os.getpid(), parentPid=os.getppid(), watcher="watching")
        stop = root / f"{config['host']}.stop"
        if row.get("released"):
            stop.touch()
        expires = read(root / "deadline.json")["expiresAt"]
        held = False
        try:
            signal.signal(signal.SIGTERM, exit_worker)
            while True:
                expired = time.time() >= expires
                stopping = (root / "watcher.stop").exists()
                if expired or stopping or stop.exists():
                    release(config, root, row, "expired" if expired else "stopped" if stopping else "manual")
                if stop.exists():
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                    held = False
                finishing = expired or stopping or bool(row.get("finishReason"))
                try:
                    observed = lead_snapshot(config, row)
                    done = set(observed["scheduler"].get("done", []))
                    failed = set(observed["scheduler"].get("failed", []))
                    coordinator = observed["coordinator"].get("outcome")
                    finishing |= terminal(coordinator) or {"IM", "IO", "IF", "IL"} <= done | failed
                    save(root, row, coordinator=coordinator,
                         feed="install-failed" if "IL" in failed else "published" if "F" in done else "waiting")
                    if finishing:
                        reason = row.get("releaseReason") or ("coordinator-terminal" if terminal(coordinator) else "installs-ended")
                        save(root, row, finishReason=reason)
                        release(config, root, row, reason)
                    if not stop.exists() and not held:
                        try:
                            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            held = True
                            save(root, row, outcome="held" if row["outcome"] == "waiting-lock" else row["outcome"], acquired=utc_now())
                            event(root, "holding", resource="live-install:" + config["host"])
                        except BlockingIOError:
                            pass
                    if held and not finishing and not stop.exists():
                        policy(config, root, row, observed)
                    clear_needed = finishing or "IF" in done | failed
                except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
                    save(root, row, watcher="retrying", error=type(error).__name__)
                    event(root, "retry", error=type(error).__name__)
                    clear_needed = finishing
                if stop.exists():
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                    held = False
                if clear_needed:
                    clear_quarantine(config, root, row)
                if expired:
                    event(root, "expired", quarantinePending=pending(row), warning=pending(row))
                if finishing and (not pending(row) or expired):
                    break
                time.sleep(min(config["interval"], max(0, expires - time.time())))
        finally:
            if pending(row):
                clear_quarantine(config, root, row)
            (root / f"{config['host']}.ready").unlink(missing_ok=True)
            save(root, row, ready=False)
            event(root, "worker-cleanup", quarantinePending=pending(row))
            try:
                lead_snapshot(config, row)
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                event(root, "exit-offline", warning=True)
        save(root, row, watcher="exited")
        event(root, "worker-exit", quarantinePending=pending(row))
        return 0
