import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class Timeline:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def run(self, stage, log, action):
        started = utc_now()
        clock = time.monotonic()
        with Path(log).open("a") as handle:
            try:
                code = action(handle)
            except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError) as error:
                handle.write(f"{type(error).__name__}: {error}\n")
                code = 1
        row = {
            "stage": stage.name,
            "host": stage.host,
            "start": started,
            "end": utc_now(),
            "seconds": round(time.monotonic() - clock, 3),
            "exit": code,
            "log": str(log),
        }
        with self.lock, self.path.open("a") as handle:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        print(f"{stage.name}: exit {code} ({row['seconds']}s); {log}", flush=True)
        return code


def latest_rows(path):
    if not Path(path).is_file():
        return {}
    rows = {}
    for line in Path(path).read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        rows[row["stage"]] = row
    return rows
