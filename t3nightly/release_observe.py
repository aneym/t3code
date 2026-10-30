import json
import os
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .release_manifest import digest


SCHEMA = "t3nightly.health-watch/1"
PROBE = r'''
import json
import os
import platform
import re
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

service, port, database = sys.argv[1], int(sys.argv[2]), Path(sys.argv[3]).expanduser()
row = {"version": None, "threadCount": None, "service": {}, "errors": []}
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/.well-known/t3/environment", timeout=3) as response:
        row["version"] = json.load(response).get("serverVersion")
    if not isinstance(row["version"], str) or not row["version"]:
        row["errors"].append("environment: missing serverVersion")
except (OSError, ValueError) as error:
    row["errors"].append(f"environment: {type(error).__name__}")
try:
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=3) as connection:
        row["threadCount"] = connection.execute("select count(*) from orchestration_v2_projection_threads").fetchone()[0]
except (sqlite3.Error, OSError) as error:
    row["errors"].append(f"threads: {type(error).__name__}")
if platform.system() == "Linux":
    probe = subprocess.run(["systemctl", "--user", "show", service, "-p", "ActiveState", "-p", "SubState", "-p", "NRestarts", "-p", "ExecMainPID"], capture_output=True, text=True, check=False, timeout=5)
    values = dict(line.split("=", 1) for line in probe.stdout.splitlines() if "=" in line)
    row["service"] = {
        "state": values.get("ActiveState", "unknown"),
        "substate": values.get("SubState", "unknown"),
        "restarts": int(values.get("NRestarts", "0")),
        "pid": int(values.get("ExecMainPID", "0")),
    }
else:
    probe = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{service}"], capture_output=True, text=True, check=False, timeout=5)
    values = dict(re.findall(r"^\t(state|pid|last exit code) = (.+)$", probe.stdout, re.MULTILINE))
    row["service"] = {
        "state": values.get("state", "unknown"),
        "substate": values.get("state", "unknown"),
        "restarts": None,
        "pid": int(values.get("pid", "0")),
    }
if probe.returncode:
    row["errors"].append("service: unavailable")
print(json.dumps(row))
'''


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_write(path, value):
    path = Path(path)
    temporary = path.with_name(f".{path.name}.next")
    with temporary.open("w") as handle:
        handle.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def probe(host, service, port, database, linux_host="ax42") -> dict:
    words = ["python3", "-c", PROBE, service, str(port), database]
    if host == "studio":
        words[0] = sys.executable
        command = words
    else:
        command = ["ssh", "-o", "BatchMode=yes", linux_host, shlex.join(words)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=20)
        if result.returncode:
            raise ValueError("probe exited nonzero")
        return json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"version": None, "threadCount": None, "service": {}, "errors": ["probe unavailable"]}


def reasons(sample, previous, expected):
    found = []
    version = sample.get("version")
    service = sample.get("service", {})
    if version and version != expected:
        found.append(f"version-regression: expected {expected}, observed {version}")
    state = service.get("state")
    if state in ("failed", "inactive", "not running", "dead"):
        found.append(f"crash-loop: service state {state}")
    if previous:
        old_count, count = previous.get("threadCount"), sample.get("threadCount")
        if old_count is not None and count is not None and count < old_count:
            found.append(f"thread-count-regression: {old_count} to {count}")
    return found


def restart_observed(sample, previous):
    if not previous:
        return False
    old = previous.get("service", {})
    current = sample.get("service", {})
    restarts, old_restarts = current.get("restarts"), old.get("restarts")
    if restarts is not None and old_restarts is not None and restarts > old_restarts:
        return True
    return bool(old.get("pid") and current.get("pid") and current["pid"] != old["pid"])


def report(host, service, expected, out, started_at, started, rows, status):
    found = [reason for row in rows for reason in row["reasons"]]
    result = {
        "schema": SCHEMA,
        "advisory": True,
        "host": host,
        "service": service,
        "expectedVersion": expected,
        "startedAt": started_at,
        "finishedAt": None if status == "running" else now(),
        "seconds": round(time.monotonic() - started, 3),
        "sampleCount": len(rows),
        "samples": str(out / "samples.jsonl"),
        "result": status,
        "reasons": found,
        "rollbackRecommendation": {
            "recommended": bool(found),
            "kind": "binary" if found else None,
            "reasons": found,
            "attempted": False,
            "databaseRestore": False,
        },
    }
    result["digest"] = digest(result)
    atomic_write(out / "health.json", result)
    return result


def watch(host, service, port, database, expected, out, duration=600, interval=10, *, linux_host="ax42"):
    if duration < 0 or interval <= 0:
        raise ValueError("duration must be nonnegative and interval must be positive")
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    samples_path = out / "samples.jsonl"
    started = time.monotonic()
    started_at = now()
    rows = []
    previous = None
    restart_streak = 0
    report(host, service, expected, out, started_at, started, rows, "running")
    with samples_path.open("x") as handle:
        while True:
            sample = probe(host, service, port, database, linux_host)
            sample["at"] = now()
            sample["seconds"] = round(time.monotonic() - started, 3)
            sample["restartObserved"] = restart_observed(sample, previous)
            restart_streak = restart_streak + 1 if sample["restartObserved"] else 0
            sample["reasons"] = reasons(sample, previous, expected)
            if restart_streak >= 2:
                sample["reasons"].append("crash-loop: repeated service process replacement")
            sample["result"] = "fail" if sample["reasons"] else ("unavailable" if sample["errors"] else "pass")
            handle.write(json.dumps(sample, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
            rows.append(sample)
            previous = sample
            report(host, service, expected, out, started_at, started, rows, "running")
            remaining = duration - (time.monotonic() - started)
            if remaining <= 0:
                break
            time.sleep(min(interval, remaining))
    found = [reason for row in rows for reason in row["reasons"]]
    status = "fail" if found else ("unavailable" if any(row["errors"] for row in rows) else "pass")
    return report(host, service, expected, out, started_at, started, rows, status)
