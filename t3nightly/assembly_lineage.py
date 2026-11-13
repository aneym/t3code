import argparse
import json
import subprocess
from pathlib import Path

from .release_ledger import LedgerRefusal, lineage, read, releases, without_commit_graph
from .release_targets import LINUX_TARGETS
from .remote_shell import ssh_argv

SERVING_PROBE = r'''
import json, urllib.request
try:
    with urllib.request.urlopen("http://127.0.0.1:3773/.well-known/t3/environment", timeout=3) as response:
        print(json.dumps(json.load(response).get("serverVersion")))
except (OSError, ValueError):
    print("null")
'''


def ancestor(repo, sha, tip):
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", sha, tip], capture_output=True).returncode == 0


def missing(repo, tips, entries):
    return [entry for entry in entries if not any(ancestor(repo, sha, tip) for sha in entry["any"] for tip in tips)]


def refusal(gaps):
    return "assembly refused: the new integration branch lacks " + "; ".join(f"{entry['label']} ({' or '.join(sha[:10] for sha in entry['any'])})" for entry in gaps)


def required(repo, ledger, serving):
    rows = releases(ledger)
    unread = sorted(host for host, version in serving.items() if version not in rows)
    if not serving or unread:
        return lineage(ledger), f"global: serving version unread or unrecorded for {', '.join(unread) or 'no target'}"
    heads = {rows[version]["head"] for version in serving.values()}
    kept = []
    for row in ledger["rows"]:
        if row.get("kind") != "release":
            kept.append(row)
            continue
        codes = {subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", row["head"], head], capture_output=True).returncode for head in heads}
        if codes - {0, 1}:
            return lineage(ledger), f"global: cannot place {row['version']} against the serving heads"
        if 0 in codes:
            kept.append(row)
    scope = ", ".join(f"{host}={version}" for host, version in sorted(serving.items()))
    return lineage({**ledger, "rows": kept}), f"targets: {scope}"


def targets(ready):
    return {host: version for host, version in ready["oldReleases"].items() if host not in ready.get("deferredHosts", {})}


def probe(host):
    try:
        result = subprocess.run([*ssh_argv(LINUX_TARGETS[host], "-oConnectTimeout=5"), "python3", "-"], input=SERVING_PROBE,
                                capture_output=True, text=True, timeout=25, check=False)
        return json.loads(result.stdout) if not result.returncode else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description="Refuse an integration branch that drops a delivered release or one-off merge in the release ledger")
    parser.add_argument("repo")
    parser.add_argument("tips", nargs="+")
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--target", action="append", default=[], choices=tuple(LINUX_TARGETS), help="release target whose live serving version scopes the lineage (repeatable)")
    parser.add_argument("--readiness", help="readiness.json whose oldReleases scope the lineage, as assembly does")
    args = parser.parse_args(argv)
    without_commit_graph()
    try:
        ledger = read(args.repo, args.remote)
    except LedgerRefusal as error:
        print(f"assembly refused: {error}")
        return 1
    serving = targets(json.loads(Path(args.readiness).read_text())) if args.readiness else {}
    serving.update({host: probe(host) for host in args.target})
    entries, scope = required(args.repo, ledger, serving) if args.readiness or args.target else (lineage(ledger), "global: no targets given")
    gaps = missing(args.repo, args.tips, entries)
    print(f"ledger {ledger['commit']} rows {len(ledger['rows'])}")
    print(f"scope {scope}")
    for entry in entries:
        print(("MISSING " if entry in gaps else "ok ") + entry["label"] + " " + " or ".join(sha[:10] for sha in entry["any"]))
    if gaps:
        print(refusal(gaps))
        return 1
    return 0
