import fcntl
import json
import os
import socket
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from .load_guard import root, signal_levels


@contextmanager
def heavy_owner(run, stage, log):
    directory = Path.home() / ".t3nightly"
    directory.mkdir(exist_ok=True, mode=0o700)
    path = directory / "heavy-workload.lock"
    if path.is_symlink():
        raise ValueError("heavy workload ownership path cannot be a symlink")
    with path.open("a+") as handle:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log.write("deferred: another nightly heavy-workload owner is active\n")
            yield False
            return
        receipt = {"at": time.time(), "host": socket.gethostname(), "pid": os.getpid(), "stage": stage,
                   "run": str(run), "scope": "one nightly heavy workload per host", "ci": ci_inventory(),
                   "auth_scopes": "not issued by heavyweight admission", "turns": "preserved; not enumerated or interrupted"}
        handle.seek(0)
        handle.truncate()
        json.dump(receipt, handle)
        handle.flush()
        try:
            receipt.update(measure())
        except (OSError, ValueError, KeyError, TypeError) as error:
            receipt.update(blockers=[f"resource sample unavailable: {error}"])
        log.write(json.dumps({"heavy_admission": receipt}) + "\n")
        log.flush()
        output = Path(run) / f"{stage}-admission.json"
        output.write_text(json.dumps(receipt, indent=2) + "\n")
        os.chmod(output, 0o600)
        yield not receipt["blockers"]


def measure():
    load = os.getloadavg()[0] / (os.cpu_count() or 1)
    blockers = []
    actual: dict = {"load_per_core": load}
    if sys.platform == "darwin":
        data = json.loads((root() / "state.json").read_text())
        if not 0 <= time.time() - data["at"] <= 120:
            raise ValueError("load-guard sample older than 120 seconds")
        sample = data["sample"]
        actual["load_guard"] = {key: sample.get(key) for key in ("load", "ncpu", "idle", "memory", "pressure", "swap", "fsync_p99_ms", "stuck")}
        actual["sample_at"] = data["at"]
        prefixes = ("io:", "memory", "swap", "studioext", "thermal")
        blockers.extend(key for key, level in signal_levels(sample).items() if key.startswith(prefixes) and level in ("soft", "hard"))
        if sample.get("fsync_p99_ms") is None or sample.get("memory") in (None, "") or not sample.get("swap"):
            blockers.append("resource sample lacks IO, memory or swap measurements")
        if sample.get("fsync_p99_ms", 0) > float(os.environ.get("FACTORY_STUDIO_FSYNC_P99_MS", 250)):
            blockers.append("IO fsync latency exceeds load-guard budget")
        if sample.get("stuck", 0) >= int(os.environ.get("FACTORY_STUDIO_STUCK_U", 16)):
            blockers.append("IO stuck processes exceed load-guard budget")
        if load > 1.5:
            blockers.append("CPU load exceeds existing installer 1.5/core budget")
    else:
        for name in ("memory", "io", "cpu"):
            text = Path(f"/proc/pressure/{name}").read_text()
            values = {line.split()[0]: dict(field.split("=") for field in line.split()[1:]) for line in text.splitlines()}
            actual[f"psi_{name}"] = values
            if name in ("memory", "io") and float(values["full"]["avg10"]) >= 20:
                blockers.append(f"{name} full PSI reached factory admit red threshold 20%")
        memory = {line.split(":")[0]: int(line.split()[1]) for line in Path("/proc/meminfo").read_text().splitlines() if line.split(":")[0] in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree")}
        actual["memory_kib"] = memory
        if memory["MemAvailable"] / memory["MemTotal"] < .15:
            blockers.append("memory availability below load-guard 15% threshold")
        if memory["SwapTotal"] - memory["SwapFree"] >= 2 * 1024**2:
            blockers.append("swap usage reached load-guard 2 GiB threshold")
        if load > 1.5:
            blockers.append("CPU load exceeds existing installer 1.5/core budget")
    return {"actuals": actual, "blockers": blockers}


def ci_inventory():
    guard = Path.home() / ".agent-rails/state/load-guard"
    result: dict = {"policy": "observe only; never stop users or CI"}
    for name in ("pause-ci.json", "close-studio.json"):
        path = guard / name
        if path.is_file() and path.stat().st_size <= 65536:
            value = json.loads(path.read_text())
            result[name] = {key: value.get(key) for key in ("at", "level", "reason")}
    group = Path("/proc/self/cgroup")
    if group.exists():
        result["own_cgroup"] = group.read_text()[:4096]
    return result
