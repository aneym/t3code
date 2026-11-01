import fcntl
import hashlib
import json
import os
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .release_config import FastConfig
from .release_host_readiness import probe_host
from .release_manifest import engine_identity


def atomic_write(path, content):
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def refresh(args, log):
    path = args.run / "readiness.json"
    config = FastConfig(args.version, args.topic, args.run, "studio", args.remote_run, args.remote_tools, args.base)
    with (args.run / ".readiness-refresh.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = path.read_bytes()
        value = json.loads(before)
        if engine_identity(config.tools)["digest"] != value["engine"]["digest"]:
            raise ValueError("readiness engine digest mismatch; use the engine that created this run")
        probe_host(config, log, args.refresh_readiness, value, require_result=True)
        value["failed"] = sorted(name for name, ok in value["checks"].items() if not ok)
        value["ok"] = not value["failed"]
        after = (json.dumps(value, indent=2) + "\n").encode()
        if path.read_bytes() != before:
            raise ValueError("readiness changed during refresh; retry against the new snapshot")
        at = datetime.now(timezone.utc).isoformat()
        receipt = {"host": args.refresh_readiness, "time": at, "reason": args.refresh_reason,
                   "oldSha256": hashlib.sha256(before).hexdigest(), "newSha256": hashlib.sha256(after).hexdigest()}
        receipt_path = path.with_name(f"readiness-refresh-{args.refresh_readiness}-{at.replace(':', '-')}.json")
        atomic_write(path, after)
        atomic_write(receipt_path, (json.dumps(receipt, indent=2) + "\n").encode())
        log.write(json.dumps({**receipt, "receipt": str(receipt_path), "ok": value["ok"]}) + "\n")
        return 0 if value["ok"] and all(value["hostChecks"][args.refresh_readiness].values()) else 1
