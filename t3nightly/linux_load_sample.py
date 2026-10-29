import os
import shutil
import time
from pathlib import Path


def _meminfo():
    values = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        values[key] = int(value.split()[0])
    return values


def _fsync_ms(directory):
    timings = []
    probe = Path(directory) / ".t3nightly-fsync-probe"
    for _ in range(5):
        started = time.monotonic()
        with probe.open("wb") as handle:
            handle.write(b"x" * 4096)
            handle.flush()
            os.fsync(handle.fileno())
        timings.append((time.monotonic() - started) * 1000)
    probe.unlink(missing_ok=True)
    return timings


def _cpu_times():
    fields = [int(value) for value in Path("/proc/stat").read_text().split("\n", 1)[0].split()[1:]]
    return fields[3] + fields[4], sum(fields)


def _stuck_processes():
    count = 0
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            state = (entry / "stat").read_text().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        count += state == "D"
    return count


def sample(directory="/tmp"):
    memory = _meminfo()
    before_idle, before_total = _cpu_times()
    fsync = _fsync_ms(directory)
    after_idle, after_total = _cpu_times()
    disk_started = time.monotonic()
    disk = shutil.disk_usage("/")
    disk_seconds = time.monotonic() - disk_started
    swap_used = (memory["SwapTotal"] - memory["SwapFree"]) // 1024
    return {
        "load": os.getloadavg()[0],
        "ncpu": os.cpu_count(),
        "idle": round(100 * (after_idle - before_idle) / max(1, after_total - before_total), 1),
        "memory": str(int(100 * memory["MemAvailable"] / memory["MemTotal"])),
        "pressure": 1,
        "swap": f"total = {memory['SwapTotal'] // 1024}M used = {swap_used}M free = {memory['SwapFree'] // 1024}M",
        "fsync_window": [round(value, 2) for value in fsync],
        "fsync_p99_ms": round(sorted(fsync)[int(0.99 * (len(fsync) - 1))], 2),
        "stuck": _stuck_processes(),
        "read_probes": {"/": {"present": True, "seconds": round(disk_seconds, 3), "free_percent": round(100 * disk.free / disk.total, 1)}},
        "host": os.uname().nodename,
        "sampler": "linux-load-sample",
    }
