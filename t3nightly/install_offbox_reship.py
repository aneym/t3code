import argparse
import json
import sqlite3
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath

from . import install_offbox as offbox
from .install_restore_copy import verify
from .install_restore_hold import engine, flocked, record_path, write

SCHEMA = "t3nightly.offbox-reship/2"
BACKOFF_S = (900, 1800, 3600, 7200)


class Run:
    def __init__(self, state):
        self.state = Path(state)

    def step(self, name, **fields):
        print(json.dumps({"step": name, **fields}), flush=True)


def now():
    return datetime.now(UTC)


def durable(value):
    write(Path(value["replicaRecord"]), {key: value[key] for key in value if key not in ("identity", "engine")})


def launch(status, value, delay=None):
    root = engine(Path(value["copy"]).parent)
    unit = f"t3nightly-offbox-reship-{uuid.uuid4().hex[:12]}"
    timer = [f"--on-active={int(delay)}", "--timer-property=AccuracySec=1min"] if delay else ["--collect"]
    command = ["systemd-run", "--user", f"--unit={unit}", *timer, f"--setenv=PYTHONPATH={root}", f"--working-directory={root}", "--",
               sys.executable, "-m", "t3nightly.install_offbox_reship", "--status", str(status)]
    value.update(engine=str(root), unit=unit, nextAt=(now() + timedelta(seconds=delay or 0)).isoformat())
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        error = result.stderr.strip()[-300:] if result.returncode else None
    except (OSError, subprocess.SubprocessError) as failure:
        error = f"{type(failure).__name__}: {failure}"
    if error:
        value.update(state="unscheduled", error=f"systemd-run failed: {error}")
    write(status, value)
    durable(value)
    return value


def start(run, local, backup):
    copy = Path(local["path"])
    status = Path(f"{copy}.reship.json")
    hold = json.loads(record_path(copy).read_text())
    value = {"schema": SCHEMA, "copy": str(copy), "remote": backup["remote"], "bytes": local["bytes"], "identity": local["identity"], "state": "scheduled",
             "attempts": 0, "capAt": hold["capAt"], "deadlineS": run.args.offbox_seed_s, "stateDir": str(run.state), "version": run.args.version,
             "replicaRecord": str(run.state / f"offbox-replica-{run.args.version}.json"), "scheduledAt": now().isoformat(), "history": []}
    launch(status, value)
    run.step("offbox-reship", remote=backup["remote"], source="local-restore-copy", unit=value["unit"], state=value["state"], status=str(status), record=value["replicaRecord"])
    return {"status": str(status), "record": value["replicaRecord"], "unit": value["unit"], "state": value["state"], "source": "local-restore-copy"}


def attempt(value):
    copy = Path(value["copy"])
    deadline = time.monotonic() + value["deadlineS"]
    try:
        verify(copy, value["identity"])
    except (OSError, ValueError, sqlite3.Error) as error:
        return "refused-corrupt-copy", f"{type(error).__name__}: {error}"
    host, _, raw = value["remote"].partition(":")
    replica = PurePosixPath(raw)
    try:
        offbox.target(f"{host}:{replica.parent}")
        offbox.sync(copy, value["remote"], deadline, background=True)
        value["backup"] = offbox.verified(Run(value["stateDir"]), host, replica.parent.parent.parent, replica, deadline,
                                          {"bytes": value["bytes"], "source": "local-restore-copy", "reship": True})
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return "failed", f"{type(error).__name__}: {error}"
    return "verified", None


def reship(status):
    value = json.loads(status.read_text())
    with flocked(f"{value['copy']}.reship.lock") as free:
        if not free:
            return value
        value.update(state="running", attempts=value["attempts"] + 1, startedAt=now().isoformat())
        write(status, value)
        durable(value)
        state, error = attempt(value)
        value["history"].append({"attempt": value["attempts"], "at": now().isoformat(), "state": state, "error": error})
        value.update(state=state, error=error, finishedAt=now().isoformat())
        if state == "failed":
            delay = BACKOFF_S[min(value["attempts"] - 1, len(BACKOFF_S) - 1)]
            if now() + timedelta(seconds=delay) < datetime.fromisoformat(value["capAt"]):
                value["state"] = "retrying"
                return launch(status, value, delay)
            value["state"] = "abandoned"
        write(status, value)
        durable(value)
        return value


def main():
    parser = argparse.ArgumentParser(prog="python -m t3nightly.install_offbox_reship",
                                     description="Ship the off-box replica from a verified stopped-database restore copy, throttled, retrying with backoff until the hold's cap.")
    parser.add_argument("--status", type=Path, required=True)
    value = reship(parser.parse_args().status)
    print(json.dumps({"state": value["state"], "error": value.get("error")}))
    return 0 if value["state"] in ("verified", "running", "retrying") else 1


if __name__ == "__main__":
    raise SystemExit(main())
