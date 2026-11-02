import json
import os
from pathlib import Path

from .release_jobs import write_status
from .release_timeline import utc_now


def read(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


def terminal(outcome):
    return bool(outcome and outcome not in ("running", "submitted"))


def snapshot(source, host, row):
    root = Path(source["run"]) / "release-holds"
    if host not in source["hosts"]:
        raise ValueError("unknown hold host")
    coordinator = read(Path(source["run"]) / "coordinator/status.json", {})
    if row:
        row["ready"] = bool(row.get("ready") and not row.get("released")
                            and not (root / f"{host}.stop").exists()
                            and not terminal(coordinator.get("outcome")))
        write_status(root / f"{host}.json", row)
        if row["ready"]:
            (root / f"{host}.ready").touch(exist_ok=True)
        else:
            (root / f"{host}.ready").unlink(missing_ok=True)
    return {"gate": Path(source["gate"]).is_file(),
            "scheduler": read(Path(source["run"]) / "scheduler.json", {}),
            "coordinator": coordinator}


def save(root, row, **changes):
    row.update(changes, updated=utc_now())
    write_status(root / "state.json", row)
    return row


def event(root, action, **fields):
    with (root / "events.jsonl").open("a") as handle:
        handle.write(json.dumps({"time": utc_now(), "action": action, **fields}, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
