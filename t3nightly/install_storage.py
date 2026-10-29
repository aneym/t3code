import hashlib
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


EXTERNAL = Path("/Volumes/StudioExt")


def private_directory(path):
    path = Path(path).absolute()
    if ".." in path.parts:
        raise ValueError("installer payload path contains parent traversal")
    if sys.platform == "darwin":
        if not EXTERNAL.is_mount() or EXTERNAL.is_symlink():
            raise ValueError("StudioExt must be mounted for installer database payloads")
        path.relative_to(EXTERNAL)
    for parent in (*reversed(path.parents), path):
        if parent.is_symlink():
            raise ValueError(f"installer payload directory is a symlink: {parent}")
        parent.mkdir(exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    return path


def payload_locations(state, home, version, backups):
    if sys.platform != "darwin":
        return private_directory(state), private_directory(Path(backups).expanduser())
    if not version or Path(version).name != version or version in (".", ".."):
        raise ValueError("invalid installer version path")
    key = hashlib.sha256(str(Path(home).absolute()).encode()).hexdigest()[:16]
    root = private_directory(EXTERNAL / "t3nightly-install-data" / key / version)
    snapshots = private_directory(root / "snapshots")
    requested = Path(backups).expanduser().absolute()
    default = Path.home() / ".t3nightly/backups"
    retained = root / "backups" if requested == default else requested
    return snapshots, private_directory(retained)


def snapshot_path(directory):
    return directory / f"install-read-snapshot-{uuid.uuid4().hex}.sqlite"


def record_payload(state, role, path, **fields):
    row = {"at": datetime.now(timezone.utc).isoformat(), "role": role, "path": str(path), **fields}
    receipt = Path(state) / "payload-placement.jsonl"
    with receipt.open("a") as handle:
        handle.write(json.dumps(row) + "\n")
    os.chmod(receipt, 0o600)
