import fcntl
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .release_config import FastConfig
from .release_host_readiness import probe_host


def atomic_write(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def refresh(args, log):
    path = args.run / "readiness.json"
    config = FastConfig(args.version, args.topic, args.run, "studio", args.remote_run, args.remote_tools, args.base)
    with (args.run / ".readiness-refresh.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = path.read_bytes()
        value = json.loads(before)
        probe_host(config, log, args.refresh_readiness, value)
        value["failed"] = sorted(name for name, ok in value["checks"].items() if not ok)
        value["ok"] = not value["failed"]
        after = (json.dumps(value, indent=2) + "\n").encode()
        if path.read_bytes() != before:
            raise ValueError("readiness changed during refresh; retry against the new snapshot")
        at = datetime.now(timezone.utc).isoformat()
        receipt = {"host": args.refresh_readiness, "time": at, "reason": args.refresh_reason,
                   "oldSha256": hashlib.sha256(before).hexdigest(), "newSha256": hashlib.sha256(after).hexdigest()}
        receipt_path = path.with_name(f"readiness-refresh-{args.refresh_readiness}-{at.replace(':', '-')}.json")
        atomic_write(receipt_path, (json.dumps(receipt, indent=2) + "\n").encode())
        atomic_write(path, after)
        log.write(json.dumps({**receipt, "receipt": str(receipt_path), "ok": value["ok"]}) + "\n")
        return 0 if value["ok"] and all(value["hostChecks"][args.refresh_readiness].values()) else 1
