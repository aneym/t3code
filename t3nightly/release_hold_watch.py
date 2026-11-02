import fcntl
import hashlib
import json
import os
import shlex
import sqlite3
import subprocess
import time
from pathlib import Path

from .release_hold_units import event, read, save, snapshot
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
            count = read(root / "secret-parked.json", {"secretParked": 0})["secretParked"]
        else:
            database = Path.home() / ".t3/userdata/statev2.sqlite"
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2) as connection:
                count = connection.execute(
                    "SELECT count(*) FROM orchestration_v2_projection_runs r "
                    "CROSS JOIN orchestration_v2_projection_turn_items i ON i.run_id = r.run_id "
                    "WHERE r.status IN ('queued','preparing','starting','running','waiting') "
                    "AND i.type = 'secret_request' AND i.status = 'waiting'"
                ).fetchone()[0]
        event(root, "secret-check", secretParked=count, warning=count != 0)
    except (OSError, ValueError, KeyError, sqlite3.Error):
        event(root, "secret-check", warning=True, unavailable=True)


def quarantine(config, root, action):
    if not config["sandbox"]:
        subprocess.run(["ssh", "-oBatchMode=yes", "-oConnectTimeout=5", "ax42",
                        shlex.join(["fleet-drain", "forge", action, "quarantine"])],
                       capture_output=True, timeout=60, check=True)
    event(root, "quarantine-" + action, sandbox=config["sandbox"])


def release(config, root, row, manual=False):
    secret_parked(config, root)
    (root / f"{config['host']}.stop").touch()
    save(root, row, outcome="released", released=utc_now(), manual=manual)
    event(root, "released", manual=manual)


def policy(config, root, row, observed):
    scheduler = observed["scheduler"]
    done = set(scheduler.get("done", []))
    failed = set(scheduler.get("failed", []))
    suffix = SUFFIX[config["host"]]
    proofs = {prefix + suffix for prefix in "REX"}
    if proofs & failed or (config["host"] == "ax42" and "TL" in failed):
        save(root, row, outcome="proofs-failed", ready=False)
    elif row.get("outcome") != "proofs-failed" and proofs <= done and observed["gate"]:
        if config["host"] == "ax42":
            if not row.get("ready"):
                (root / "ax42.ready").touch()
                save(root, row, outcome="ready-manual", ready=True, readyAt=utc_now(),
                     next="Factory pause and disk-mover hold, then manual release")
                event(root, "ready-manual")
        elif config["host"] == "forge":
            if not row.get("quarantineAt"):
                quarantine(config, root, "add")
                save(root, row, quarantineAt=time.time())
            if time.time() >= row["quarantineAt"] + config["quarantineSeconds"]:
                release(config, root, row)
        else:
            release(config, root, row)
    return done, failed


def worker(root):
    root = Path(root).resolve()
    config = read(root / "config.json")
    with (root / "worker.lock").open("a") as owner:
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        row = read(root / "state.json", {"outcome": "waiting-lock", "host": config["host"]})
        save(root, row, pid=os.getpid(), parentPid=os.getppid())
        stop = root / f"{config['host']}.stop"
        lock_root = Path(config["lockRoot"])
        lock_root.mkdir(parents=True, exist_ok=True)
        resource = "live-install:" + config["host"]
        handle = (lock_root / hashlib.sha256(resource.encode()).hexdigest()).open("a")
        held = False
        try:
            while True:
                try:
                    stopping = (root / "watcher.stop").exists()
                    if stop.exists() and row.get("outcome") != "released" and not row.get("released"):
                        release(config, root, row, manual=True)
                    if stop.exists() and held:
                        fcntl.flock(handle, fcntl.LOCK_UN)
                        held = False
                    if not stop.exists() and not held:
                        try:
                            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            held = True
                            save(root, row, outcome=row["outcome"] if row["outcome"] != "waiting-lock" else "held", acquired=utc_now())
                            event(root, "holding", resource=resource)
                        except BlockingIOError:
                            pass
                    if stopping:
                        if row.get("quarantineAt") and not row.get("quarantineCleared"):
                            quarantine(config, root, "clear")
                            save(root, row, quarantineCleared=utc_now())
                        save(root, row, watcher="stopped")
                        try:
                            lead_snapshot(config, row)
                        except (OSError, ValueError, subprocess.SubprocessError):
                            event(root, "stopped-offline")
                        return 0
                    observed = lead_snapshot(config, row)
                    done = set(observed["scheduler"].get("done", []))
                    failed = set(observed["scheduler"].get("failed", []))
                    coordinator = observed["coordinator"].get("outcome")
                    save(root, row, coordinator=coordinator,
                         feed="install-failed" if "IL" in failed else "published" if "F" in done else "waiting")
                    terminal = bool(coordinator and coordinator not in ("running", "submitted"))
                    if held and not terminal:
                        done, failed = policy(config, root, row, observed)
                    if stop.exists() and held:
                        fcntl.flock(handle, fcntl.LOCK_UN)
                        held = False
                    if row.get("quarantineAt") and not row.get("quarantineCleared"):
                        if "IF" in done | failed:
                            quarantine(config, root, "clear")
                            save(root, row, quarantineCleared=utc_now())
                    save(root, row, watcher="watching")
                    lead_snapshot(config, row)
                except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
                    save(root, row, watcher="retrying", error=type(error).__name__)
                    event(root, "retry", error=type(error).__name__)
                time.sleep(config["interval"])
        finally:
            handle.close()
