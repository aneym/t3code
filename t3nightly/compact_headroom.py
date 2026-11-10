import argparse
import json
import shutil
from pathlib import Path

GIB = 1024**3
RATIO = 2.5
DEFAULT_DATABASE = Path.home() / ".t3/userdata/statev2.sqlite"


def file_bytes(path):
    return path.stat().st_size if path.exists() else 0


def headroom(db):
    db = Path(db)
    database = file_bytes(db)
    wal = file_bytes(Path(f"{db}-wal"))
    free = shutil.disk_usage(db.parent).free
    required = int(RATIO * (database + wal))
    return {"directory": str(db.parent), "databaseBytes": database, "walBytes": wal, "freeBytes": free, "ratio": RATIO,
            "requiredBytes": required, "passes": free >= required}


def refusal(check):
    gib = {key: round(check[key] / GIB, 2) for key in ("databaseBytes", "walBytes", "freeBytes", "requiredBytes")}
    return (f"database volume has {gib['freeBytes']} GiB free, under {check['ratio']}x the database plus WAL "
            f"({gib['databaseBytes']} GiB + {gib['walBytes']} GiB = {gib['requiredBytes']} GiB required)")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="compact-space-check", description="Report whether install --compact-db would compact or skip for free space on the database volume. Only stats files.")
    parser.add_argument("database", nargs="?", default=str(DEFAULT_DATABASE), help=f"database path (default: {DEFAULT_DATABASE})")
    args = parser.parse_args(argv)
    check = headroom(args.database)
    decision = {"decision": "compact"} if check["passes"] else {"decision": "skip", "reason": refusal(check)}
    print(json.dumps({"database": args.database, **check, **decision}, indent=2))
    return 0
