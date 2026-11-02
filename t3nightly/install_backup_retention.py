import argparse
import json
import sys
import time
from pathlib import Path

SCHEMA = "t3nightly.at-stop-backup/1"
LEGACY_APPROVAL = Path.home() / ".open-factory/approvals/alex-t3nightly-legacy-backup-delete.json"


def inventory(root, home=None):
    rows = []
    for directory in Path(root).iterdir():
        if directory.is_symlink() or not directory.is_dir():
            continue
        db = directory / "statev2.sqlite"
        if db.is_symlink() or not db.is_file():
            continue
        marker = directory / "at-stop.json"
        try:
            value = json.loads(marker.read_text()) if not marker.is_symlink() else {}
        except (OSError, ValueError):
            value = {}
        if not isinstance(value, dict):
            value = {}
        created = value.get("createdNs")
        owned = home is not None and value.get("home") == str(Path(home).resolve())
        stat = db.stat()
        rows.append({"path": str(db), "bytes": stat.st_size, "allocatedBytes": stat.st_blocks * 512,
                     "ageSeconds": max(0, time.time() - stat.st_mtime), "createdNs": created if type(created) is int else 0,
                     "home": value.get("home"), "marked": owned and type(created) is int and value.get("schema") == SCHEMA and value.get("path") == str(db) and value.get("complete") is True})
    return rows


def mark(path, metadata, home):
    path = Path(path)
    marker = path.parent / "at-stop.json"
    marker.write_text(json.dumps({**metadata, "home": str(Path(home).resolve()), "schema": SCHEMA, "path": str(path), "createdNs": time.time_ns(), "complete": True}) + "\n")
    marker.chmod(0o600)


def retain(root, current, home):
    from .install_payload_gc import payload_lock

    root = Path(root)
    result = {"removed": [], "legacyKept": [], "kept": [], "legacyApprovalPath": str(LEGACY_APPROVAL)}
    with payload_lock(root, root / "at-stop-retention") as acquired:
        if not acquired:
            return {**result, "deferred": True}
        rows = inventory(root, home)
        marked = sorted((row for row in rows if row["marked"]), key=lambda row: row["createdNs"], reverse=True)
        result["legacyKept"] = [row for row in rows if not row["marked"]]
        protected = {row["path"] for row in marked[:2]}
        if current:
            protected.add(str(Path(current)))
            older = [row for row in marked if row["path"] == str(Path(current))]
            if older:
                previous = next((row for row in marked if row["createdNs"] < older[0]["createdNs"]), None)
                if previous:
                    protected.add(previous["path"])
        for row in marked:
            if row["path"] in protected:
                result["kept"].append(row)
                continue
            db = Path(row["path"])
            for suffix in ("", "-wal", "-shm", "-journal"):
                Path(str(db) + suffix).unlink(missing_ok=True)
            (db.parent / "at-stop.json").unlink()
            (db.parent / "payload.json").unlink(missing_ok=True)
            for name in ("secrets", "settings.json", "restart-resume.json"):
                (db.parent / name).unlink(missing_ok=True)
            db.parent.rmdir()
            result["removed"].append(row)
    return result


def main():
    parser = argparse.ArgumentParser(description="Report at-stop backup count and allocated size (APFS shared extents may be counted more than once).")
    parser.add_argument("--home", type=Path)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    all_rows = inventory(args.root, args.home)
    rows = [row for row in all_rows if row["marked"]]
    print(json.dumps({"count": len(rows), "logicalBytes": sum(row["bytes"] for row in rows), "allocatedBytes": sum(row["allocatedBytes"] for row in rows), "privateBytes": sum(row["allocatedBytes"] for row in rows) if sys.platform != "darwin" else None, "privateSizeReason": "Linux full copies use allocated blocks; APFS shared extent ownership requires volume df before/after", "backups": rows, "legacyOrForeign": [row for row in all_rows if not row["marked"]]}))


def best_effort(root, current, home, *, metadata=None):
    try:
        if current and metadata is not None:
            mark(current, metadata, home)
        return retain(root, current, home)
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}


if __name__ == "__main__":
    main()
