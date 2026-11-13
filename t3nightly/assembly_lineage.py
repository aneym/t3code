import argparse
import subprocess

from .release_ledger import LedgerRefusal, lineage, read, without_commit_graph


def ancestor(repo, sha, tip):
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", sha, tip], capture_output=True).returncode == 0


def missing(repo, tips, entries):
    return [entry for entry in entries if not any(ancestor(repo, sha, tip) for sha in entry["any"] for tip in tips)]


def refusal(gaps):
    return "assembly refused: the new integration branch lacks " + "; ".join(f"{entry['label']} ({' or '.join(sha[:10] for sha in entry['any'])})" for entry in gaps)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Refuse an integration branch that drops a delivered release or one-off merge in the release ledger")
    parser.add_argument("repo")
    parser.add_argument("tips", nargs="+")
    parser.add_argument("--remote", default="origin")
    args = parser.parse_args(argv)
    without_commit_graph()
    try:
        ledger = read(args.repo, args.remote)
    except LedgerRefusal as error:
        print(f"assembly refused: {error}")
        return 1
    entries = lineage(ledger)
    gaps = missing(args.repo, args.tips, entries)
    print(f"ledger {ledger['commit']} rows {len(ledger['rows'])}")
    for entry in entries:
        print(("MISSING " if entry in gaps else "ok ") + entry["label"] + " " + " or ".join(sha[:10] for sha in entry["any"]))
    if gaps:
        print(refusal(gaps))
        return 1
    return 0
