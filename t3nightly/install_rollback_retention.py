import argparse
import datetime
import json
import os
import re
import secrets
import sys
from pathlib import Path

KEEP = 3


def version_key(name):
    return tuple(int(part) for part in re.findall(r"\d+", name))


def allocated(path):
    info = os.lstat(path)
    total = unique = info.st_blocks * 512
    if path.is_dir() and not path.is_symlink():
        for directory, dirs, files in os.walk(path, followlinks=False):
            for name in dirs + files:
                entry = os.lstat(os.path.join(directory, name))
                total += entry.st_blocks * 512
                if entry.st_nlink == 1 or name in dirs:
                    unique += entry.st_blocks * 512
    return total, unique


def trash(path, home):
    root = Path(os.path.realpath(Path.home() / ".agent-trash"))
    if not root.exists() or os.stat(root).st_dev != os.lstat(path).st_dev:
        root = Path(home) / "runtime" / ".agent-trash"
    destination = root / datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d") / secrets.token_hex(6) / path.name
    destination.parent.mkdir(parents=True, mode=0o700)
    os.rename(path, destination)
    receipts = Path.home() / ".agent-rails/trash/receipts.jsonl"
    receipts.parent.mkdir(parents=True, exist_ok=True)
    row = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(), "src": str(path), "dst": str(destination), "cwd": os.getcwd(), "pid": os.getpid(),
           "T3_THREAD_ID": os.environ.get("T3_THREAD_ID", ""), "root": str(destination.parent.parent.parent), "by": "t3nightly.install_rollback_retention"}
    fd = os.open(receipts, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (json.dumps(row) + "\n").encode())
    finally:
        os.close(fd)
    return destination


def protected_versions(home, extra=()):
    keep = set(extra)
    state = Path(home) / "runtime" / "service-state.json"
    try:
        value = json.loads(state.read_text())
    except (OSError, ValueError):
        raise ValueError("service-state.json is unreadable; rollback retention needs the serving and rollback versions")
    keep.add(value.get("activeVersion"))
    keep.add((value.get("update") or {}).get("fromVersion"))
    return {version for version in keep if version}


def trim(home, protect=(), *, keep=KEEP, dry_run=False):
    store = Path(home) / "runtime" / ".rollback-runtime"
    if not store.is_dir():
        return {"store": str(store), "kept": [], "trashed": []}
    guarded = protected_versions(home, protect)
    entries = sorted((entry for entry in store.iterdir() if not entry.name.startswith(".")), key=lambda entry: version_key(entry.name), reverse=True)
    kept, trashed = [], []
    for entry in entries:
        if entry.name in guarded or len(kept) < keep:
            kept.append(entry.name)
            continue
        total, unique = allocated(entry)
        row = {"version": entry.name, "symlink": entry.is_symlink(), "allocatedBytes": total, "uniqueBytes": unique}
        if not dry_run:
            row["trash"] = str(trash(entry, home))
        trashed.append(row)
    return {"store": str(store), "keep": keep, "protected": sorted(guarded), "kept": kept, "trashed": trashed,
            "uniqueBytes": sum(row["uniqueBytes"] for row in trashed), "allocatedBytes": sum(row["allocatedBytes"] for row in trashed)}


def apply(run, *versions):
    try:
        result = trim(run.home, versions)
    except (OSError, ValueError) as error:
        run.step("rollback-runtime-retention-skipped", error=str(error))
        return
    run.report["rollbackRuntimeRetention"] = result
    run.step("rollback-runtime-retention", kept=len(result["kept"]), trashed=len(result["trashed"]), unique_bytes=result.get("uniqueBytes", 0))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="install_rollback_retention")
    parser.add_argument("--home", default=str(Path.home() / ".t3"))
    parser.add_argument("--keep", type=int, default=KEEP)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.keep < 1:
        parser.error("--keep must be at least 1")
    print(json.dumps(trim(args.home, keep=args.keep, dry_run=args.dry_run), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
