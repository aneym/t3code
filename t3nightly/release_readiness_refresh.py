import hashlib
import json
from datetime import datetime, timezone

from .release_config import FastConfig
from .release_host_readiness import probe_host
from .release_ledger import read as read_ledger
from .release_targets import linux_target
from .release_manifest import engine_identity
from .release_readiness_store import atomic_write, readiness_lock


def refresh(args, log):
    host = linux_target(args.linux_host) if "studio" in args.defer_host else "studio"
    config = FastConfig(args.version, args.topic, args.run, host, args.remote_run, args.remote_tools, args.base)
    with readiness_lock(args.run) as path:
        before = path.read_bytes()
        value = json.loads(before)
        if engine_identity(config.tools)["digest"] != value["engine"]["digest"]:
            raise ValueError("readiness engine digest mismatch; use the engine that created this run")
        value["ledger"] = read_ledger(config.repo)
        probe_host(config, log, args.refresh_readiness, value, require_result=True)
        value.pop("ledger")
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
        return 0 if all(value["hostChecks"][args.refresh_readiness].values()) else 1
