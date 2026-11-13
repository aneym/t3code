import argparse
import hashlib
import json
import sys
from pathlib import Path

from .release_ledger import LedgerRefusal, git, publish_candidate, read, record_release, seed, without_commit_graph
from .release_manifest import topics


def seed_rows(delivered, expected, tip, label):
    path = Path(delivered)
    if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        merges = json.loads(path.read_text())["merges"]
        return "delivered-merges", [{"kind": "merge", "label": row["label"], "any": row["any"]} for row in merges]
    return "integration-tip", [{"kind": "merge", "label": label, "any": [tip]}]


def release_topics(repo, base, head):
    rows = [row for row in topics(repo, base, head) if row["kind"] == "merge"]
    if not rows or any(not row["branch"] for row in rows):
        raise LedgerRefusal(f"{head[:12]} has no named topic merges over {base[:12]}")
    return [(row["branch"], row["sha"]) for row in rows]


def add_release(args):
    if args.bundle:
        git(args.repo, "fetch", "--no-tags", args.bundle, "HEAD")
    head = git(args.repo, "rev-parse", f"{args.head}^{{commit}}").stdout.strip()
    base = git(args.repo, "rev-parse", f"{args.base}^{{commit}}").stdout.strip()
    pairs = release_topics(args.repo, base, head)
    ref = publish_candidate(args.repo, args.version, head, args.remote)
    commit = record_release(args.repo, args.version, head, base, pairs, args.recorded_by, args.remote)
    return {"version": args.version, "head": head, "base": base, "topics": pairs, "candidateRef": ref, "ledger": commit}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read, seed or extend the fast-forward-only release ledger on origin")
    parser.add_argument("--repo", default="/home/jobs/repos/t3code")
    parser.add_argument("--remote", default="origin")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("show")
    seeding = commands.add_parser("seed")
    seeding.add_argument("--delivered", default=str(Path.home() / ".t3nightly/delivered-merges.json"))
    seeding.add_argument("--delivered-sha256", required=True)
    seeding.add_argument("--tip", required=True)
    seeding.add_argument("--tip-label", required=True)
    adding = commands.add_parser("add-release")
    adding.add_argument("--version", required=True)
    adding.add_argument("--base", required=True)
    adding.add_argument("--head", required=True)
    adding.add_argument("--bundle", default="")
    adding.add_argument("--recorded-by", required=True)
    args = parser.parse_args(argv)
    without_commit_graph()
    try:
        if args.command == "show":
            ledger = read(args.repo, args.remote)
            result = {"ledger": ledger["commit"], "rows": len(ledger["rows"]), "releases": sorted(row["version"] for row in ledger["rows"] if row.get("kind") == "release")}
        elif args.command == "seed":
            git(args.repo, "cat-file", "-e", f"{args.tip}^{{commit}}")
            source, rows = seed_rows(args.delivered, args.delivered_sha256, git(args.repo, "rev-parse", f"{args.tip}^{{commit}}").stdout.strip(), args.tip_label)
            ledger = seed(args.repo, rows, f"seed release ledger from {source}", args.remote)
            result = {"ledger": ledger["commit"], "rows": len(ledger["rows"]), "source": source}
        else:
            result = add_release(args)
    except LedgerRefusal as error:
        print(f"release-ledger: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0
