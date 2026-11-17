import os
import subprocess
import uuid
from pathlib import Path

GIB = 1024**3
CRITICAL_USED_PCT = 93
PCT_FREE_GIB = 100
ROOT_FREE_GIB = 40
FILL_HOURS = 3
SMALL_BYTES = GIB
MIN_WRITE_BPS = 1 << 20


def warn_pct():
    return float(os.environ.get("FLEET_DISK_ALERT_USED_PCT", 85))


def mount_of(path):
    path = Path(path).resolve()
    while not os.path.ismount(path):
        path = path.parent
    return str(path)


def level(mount, used_pct, free):
    if used_pct >= CRITICAL_USED_PCT or free <= 0 or (mount == "/" and free < ROOT_FREE_GIB * GIB):
        return "critical"
    if used_pct >= warn_pct() and free < PCT_FREE_GIB * GIB:
        return "warn"
    return "ok"


def projected(path, new_bytes):
    usage = os.statvfs(path)
    free = usage.f_bavail * usage.f_frsize
    used = (usage.f_blocks - usage.f_bfree) * usage.f_frsize
    total = used + free
    after = free - new_bytes
    mount = mount_of(path)

    def pct(left):
        return round(100 * (total - left) / total, 1) if total else 100.0

    return {"path": str(path), "mount": mount, "newBytes": int(new_bytes), "freeBytes": free, "usedPct": pct(free), "freeAfterBytes": after, "usedPctAfter": pct(after),
            "levelNow": level(mount, pct(free), free), "levelAfter": level(mount, pct(after), after), "warnPct": warn_pct(), "criticalPct": CRITICAL_USED_PCT}


def require(path, new_bytes, what, note):
    room = projected(path, new_bytes)
    note("disk-room", what=what, **room)
    if room["levelAfter"] != "ok" and new_bytes >= SMALL_BYTES:
        raise ValueError(f"{what} would write {new_bytes / GIB:.1f} GiB to {room['mount']}, taking it to {room['usedPctAfter']}% used with {room['freeAfterBytes'] / GIB:.1f} GiB free, past the disk-watch {room['levelAfter']} line; nothing copied, nothing stopped")
    return room


def write_rate(path):
    usage = os.statvfs(path)
    return max(MIN_WRITE_BPS, usage.f_bavail * usage.f_frsize // ((FILL_HOURS + 1) * 3600))


def reflinks(directory):
    probe = Path(directory) / f".reflink-probe-{uuid.uuid4().hex}"
    copied = Path(f"{probe}.copy")
    try:
        probe.write_bytes(b"\0" * 4096)
        result = subprocess.run(["cp", "--reflink=always", str(probe), str(copied)], capture_output=True, timeout=10, check=False)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        probe.unlink(missing_ok=True)
        copied.unlink(missing_ok=True)
