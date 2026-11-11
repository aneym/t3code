import argparse
import json
import subprocess
from pathlib import Path

DELIVERED = Path.home() / ".t3nightly/delivered-merges.json"


def delivered_entries(path=DELIVERED):
    path = Path(path)
    return json.loads(path.read_text())["merges"] if path.is_file() else []


def release_entries(runs_root, versions):
    entries = []
    for version in sorted(set(versions)):
        root = Path(runs_root) / version
        for path in sorted({*root.glob("*/assembly.json"), *root.glob("assembly.json")}):
            assembly = json.loads(path.read_text())
            for name, sha in zip(assembly.get("topics", []), assembly.get("topicShas", [])):
                entries.append({"label": f"{version} {name}", "any": [sha, assembly["head"]]})
            break
    return entries


def ancestor(repo, sha, tip):
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", sha, tip], capture_output=True).returncode == 0


def missing(repo, tips, entries):
    return [entry for entry in entries if not any(ancestor(repo, sha, tip) for sha in entry["any"] for tip in tips)]


def refusal(gaps):
    return "assembly refused: the new integration branch lacks " + "; ".join(f"{entry['label']} ({' or '.join(sha[:10] for sha in entry['any'])})" for entry in gaps)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Refuse an integration branch that drops a delivered release or one-off merge")
    parser.add_argument("repo")
    parser.add_argument("tips", nargs="+")
    parser.add_argument("--delivered", default=str(DELIVERED))
    parser.add_argument("--runs", default=str(Path.home() / ".t3nightly/runs"))
    parser.add_argument("--release", action="append", default=[])
    args = parser.parse_args(argv)
    entries = [*delivered_entries(args.delivered), *release_entries(args.runs, args.release)]
    gaps = missing(args.repo, args.tips, entries)
    for entry in entries:
        print(("MISSING " if entry in gaps else "ok ") + entry["label"] + " " + " or ".join(sha[:10] for sha in entry["any"]))
    if gaps:
        print(refusal(gaps))
        return 1
    return 0
