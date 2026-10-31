import argparse
import json
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from . import install_offbox as offbox
from .install_restore_hold import engine, flocked, write

SCHEMA = "t3nightly.offbox-reship/1"


class Run:
    def __init__(self, state):
        self.state = Path(state)

    def step(self, name, **fields):
        print(json.dumps({"step": name, **fields}), flush=True)


def start(run, local, backup):
    copy = Path(local["path"])
    status = Path(f"{copy}.reship.json")
    root = engine(copy.parent)
    unit = f"t3nightly-offbox-reship-{uuid.uuid4().hex[:12]}"
    value = {"schema": SCHEMA, "copy": str(copy), "remote": backup["remote"], "bytes": local["bytes"], "identity": local["identity"], "state": "scheduled", "unit": unit,
             "engine": str(root), "deadlineS": run.args.offbox_seed_s, "stateDir": str(run.state), "scheduledAt": datetime.now(UTC).isoformat()}
    command = ["systemd-run", "--user", f"--unit={unit}", "--collect", f"--setenv=PYTHONPATH={root}", f"--working-directory={root}", "--",
               sys.executable, "-m", "t3nightly.install_offbox_reship", "--status", str(status)]
    write(status, value)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        if result.returncode:
            value.update(state="unscheduled", error=f"systemd-run failed: {result.stderr.strip()[-300:]}")
    except (OSError, subprocess.SubprocessError) as error:
        value.update(state="unscheduled", error=f"systemd-run failed: {type(error).__name__}: {error}")
    write(status, value)
    run.step("offbox-reship", remote=backup["remote"], source="local-restore-copy", unit=unit, state=value["state"], status=str(status))
    return {"status": str(status), "unit": unit, "state": value["state"], "source": "local-restore-copy"}


def reship(status):
    value = json.loads(status.read_text())
    copy = Path(value["copy"])
    with flocked(f"{copy}.reship.lock") as free:
        if not free:
            return value
        value.update(state="running", startedAt=datetime.now(UTC).isoformat())
        write(status, value)
        deadline = time.monotonic() + value["deadlineS"]
        host, _, raw = value["remote"].partition(":")
        replica = PurePosixPath(raw)
        try:
            offbox.target(f"{host}:{replica.parent}")
            offbox.sync(copy, value["remote"], deadline, background=True)
            value["backup"] = offbox.verified(Run(value["stateDir"]), host, replica.parent.parent.parent, replica, deadline,
                                              {"bytes": value["bytes"], "source": "local-restore-copy", "reship": True})
            value["state"] = "verified"
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            value.update(state="failed", error=f"{type(error).__name__}: {error}")
        value["finishedAt"] = datetime.now(UTC).isoformat()
        write(status, value)
        return value


def main():
    parser = argparse.ArgumentParser(prog="python -m t3nightly.install_offbox_reship",
                                     description="Ship the off-box replica from a verified stopped-database restore copy, throttled, after a degraded final sync.")
    parser.add_argument("--status", type=Path, required=True)
    value = reship(parser.parse_args().status)
    print(json.dumps({"state": value["state"], "error": value.get("error")}))
    return 0 if value["state"] in ("verified", "running") else 1


if __name__ == "__main__":
    raise SystemExit(main())
