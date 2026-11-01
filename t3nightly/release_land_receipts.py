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


def post(receipts, out, git, version):
    rows = []
    out.parent.mkdir(parents=True, exist_ok=True)
    for receipt in receipts:
        try:
            result = subprocess.run(["land-receipt", "release", "--repo", str(git), "--branch", receipt["branch"], "--version", version],
                                    capture_output=True, text=True, timeout=180, check=False)
        except subprocess.TimeoutExpired as error:
            stdout = error.stdout.decode(errors="replace") if isinstance(error.stdout, bytes) else error.stdout or ""
            stderr = error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) else error.stderr or ""
            raise RuntimeError(f"land-receipt release timed out: {stdout}{stderr}") from error
        rows.append({**receipt, "releaseReturncode": result.returncode, "releaseStdout": result.stdout,
                     "releaseStderr": result.stderr, "delivered": False})
        out.write_text(json.dumps(rows, indent=2) + "\n")
        if result.returncode:
            raise RuntimeError(f"land-receipt release failed ({result.returncode}): {result.stdout}{result.stderr}")
    send = sender() if rows else None
    for row in rows:
        row["delivered"] = send({key: row[key] for key in ("repo", "branch", "head", "main_sha", "at", "parent")},
                                "RAILS_LAND_RECEIPT_KEY", "rails-land-receipt-key")
        out.write_text(json.dumps(rows, indent=2) + "\n")
    if not rows:
        out.write_text("[]\n")
    return all(row["delivered"] for row in rows)


def from_manifest(manifest):
    data = json.loads(Path(manifest).read_text())
    return data["source"]["commit"], [(topic["branch"], topic["sha"]) for topic in data["topics"] if topic.get("kind") == "merge" and topic.get("branch")]


def publish(config, log):
    try:
        if json.loads(config.outcome().read_text())["outcome"] not in ("installed", "current"):
            log.write(json.dumps({"step": "landing-receipts-skipped", "reason": "studio install did not succeed"}) + "\n")
            return 0
        main_sha, topics = from_manifest(config.manifest)
        delivered = post(build(config.tools.parent, main_sha, topics), config.run / "receipts" / "landing-receipts.json", config.tools.parent, config.version)
        log.write(json.dumps({"step": "landing-receipts", "delivered": delivered, "topics": len(topics)}) + "\n")
        return 0 if delivered else 1
    except Exception as error:
        log.write(json.dumps({"step": "landing-receipts-failed", "error": f"{type(error).__name__}: {error}"}) + "\n")
        return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--build")
    parser.add_argument("--version")
    parser.add_argument("--topic", action="append", default=[], help="branch=full-sha")
    parser.add_argument("--git", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.manifest:
        main_sha, topics = from_manifest(args.manifest)
        args.version = args.version or json.loads(args.manifest.read_text())["version"]
    else:
        main_sha, topics = args.build, [tuple(item.split("=", 1)) for item in args.topic]
    if not args.version:
        parser.error("--version is required without a versioned manifest")
    delivered = post(build(args.git, main_sha, topics), args.out, args.git, args.version)
    print(json.dumps({"delivered": delivered, "topics": len(topics), "out": str(args.out)}))
    return 0 if delivered else 1
