import argparse
import importlib.util
import json
import os
import re
import subprocess
from pathlib import Path

REPO = "aneym/t3code"
SHA = re.compile(r"[0-9a-f]{40}")


def sender():
    root = Path(os.environ.get("AGENT_RAILS_ROOT", "/Volumes/StudioExt/repos/agent-rails"))
    spec = importlib.util.spec_from_file_location("agent_rails_land_receipts", root / "scripts/merge_gate/land_receipts.py")
    if spec is None or spec.loader is None:
        raise ImportError("agent-rails land_receipts is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.send


def build(git, main_sha, topics):
    if not SHA.fullmatch(main_sha) or not all(SHA.fullmatch(head) for _, head in topics):
        raise ValueError("landing receipts need full build and topic SHAs")
    committed, parent = subprocess.run(["git", "-C", str(git), "show", "-s", "--format=%ct %P", main_sha],
                                       capture_output=True, text=True, check=True, timeout=15).stdout.split()[:2]
    return [{"repo": REPO, "branch": branch, "head": head, "main_sha": main_sha, "at": int(committed), "parent": parent} for branch, head in topics]


def post(receipts, out):
    send = sender()
    rows = [{**receipt, "delivered": send(receipt, "RAILS_LAND_RECEIPT_KEY", "rails-land-receipt-key")} for receipt in receipts]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, indent=2) + "\n")
    return all(row["delivered"] for row in rows)


def from_manifest(manifest):
    data = json.loads(Path(manifest).read_text())
    return data["source"]["commit"], [(topic["branch"], topic["sha"]) for topic in data["topics"] if topic.get("kind") == "merge" and topic.get("branch")]


def publish(config, log):
    try:
        if json.loads(config.outcome().read_text())["outcome"] not in ("installed", "current"):
            log.write(json.dumps({"step": "landing-receipts-skipped", "reason": "studio install did not succeed"}) + "\n")
            return
        main_sha, topics = from_manifest(config.manifest)
        delivered = post(build(config.tools.parent, main_sha, topics), config.run / "receipts" / "landing-receipts.json")
        log.write(json.dumps({"step": "landing-receipts", "delivered": delivered, "topics": len(topics)}) + "\n")
    except Exception as error:
        log.write(json.dumps({"step": "landing-receipts-failed", "error": f"{type(error).__name__}: {error}"}) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--build")
    parser.add_argument("--topic", action="append", default=[], help="branch=full-sha")
    parser.add_argument("--git", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.manifest:
        main_sha, topics = from_manifest(args.manifest)
    else:
        main_sha, topics = args.build, [tuple(item.split("=", 1)) for item in args.topic]
    delivered = post(build(args.git, main_sha, topics), args.out)
    print(json.dumps({"delivered": delivered, "topics": len(topics), "out": str(args.out)}))
    return 0 if delivered else 1
