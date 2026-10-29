import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from t3nightly.release_manifest import MIGRATIONS_FILE, migration_identity


def migration_names(tree, ref=None):
    source = (
        Path(tree, MIGRATIONS_FILE).read_text()
        if ref is None
        else subprocess.run(
            ["git", "-C", str(tree), "show", f"{ref}:{MIGRATIONS_FILE}"],
            text=True, capture_output=True, check=True,
        ).stdout
    )
    names = {int(number): name for number, name in re.findall(r"\[(\d+),\s*\"([^\"]+)\"", source)}
    return names, migration_identity(tree, ref)


def main():
    parser = argparse.ArgumentParser(description="Check fork migration ids against upstream.")
    parser.add_argument("--tree", type=Path, required=True)
    parser.add_argument("--upstream", default="upstream/main")
    parser.add_argument("--fork-min", type=int, default=9000)
    args = parser.parse_args()
    fork, fork_identity = migration_names(args.tree)
    upstream, upstream_identity = migration_names(args.tree, args.upstream)
    fork = {int(number): name for number, name in fork.items()}
    upstream = {int(number): name for number, name in upstream.items()}
    collisions = [
        {"id": number, "fork": fork[number], "upstream": upstream[number]}
        for number in sorted(set(fork) & set(upstream))
        if fork[number] != upstream[number]
    ]
    fork_only = set(fork) - set(upstream)
    out_of_range = [number for number in fork_only if number < args.fork_min]
    out = {
        "ok": not collisions and not out_of_range,
        "forkMin": args.fork_min,
        "forkMax": max(fork_identity["ids"]),
        "upstreamMax": max(upstream_identity["ids"]),
        "collisions": collisions,
        "outOfRange": sorted(out_of_range),
    }
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0 if not collisions and not out_of_range else 2


if __name__ == "__main__":
    raise SystemExit(main())
