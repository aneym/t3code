import fcntl
import glob
import os
import time
from pathlib import Path

DEFAULT_LOCKS = (
    "~/.local/state/rails-one-land/active/*",
    "~/.local/state/rails-one-land/check-slots/slot-*",
)
DEFAULT_WAIT_S = 1800
MAX_WAIT_S = 7200
POLL_S = 5


class LandActive(ValueError):
    pass


def patterns(args):
    chosen = getattr(args, "land_lock", None)
    if chosen is None:
        return list(DEFAULT_LOCKS)
    return [pattern for pattern in chosen if pattern and pattern != "none"]


def held(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return False
    try:
        fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    except OSError:
        return False
    else:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        return False
    finally:
        os.close(descriptor)


def active(chosen):
    found = []
    for pattern in chosen:
        for path in sorted(glob.glob(os.path.expanduser(pattern))):
            if Path(path).is_file() and held(path):
                found.append(path)
    return found


def wait(run, phase, budget=None):
    chosen = patterns(run.args)
    if not chosen:
        return None
    bound = run.args.land_wait_s if budget is None else budget
    spent = getattr(run, "land_waited_s", 0.0)
    started = time.monotonic()
    while True:
        locks = active(chosen)
        waited = spent + time.monotonic() - started
        if not locks or waited >= bound:
            break
        time.sleep(max(0.0, min(POLL_S, bound - waited)))
    run.land_waited_s = waited
    record = {"phase": phase, "outcome": "clear" if not locks else "timed-out", "waitedSeconds": round(waited, 3), "boundSeconds": bound,
              "via": "flock probe", "patterns": chosen, "held": locks}
    run.report.setdefault("landGate", []).append(record)
    run.step("land-gate-wait", **record)
    if locks:
        error = LandActive(f"rails-one land still running after the {bound} s --land-wait-s bound: {', '.join(locks)}; install aborted before the stop, nothing stopped")
        error.record = record
        raise error
    return record
