import json
from pathlib import Path


def internal(path):
    resolved = Path(path).expanduser().resolve()
    if not resolved.is_relative_to((Path.home() / ".t3nightly").resolve()):
        raise ValueError("macOS rehearsal requires internal ~/.t3nightly home, seed, staging, evidence, artifacts and RPC tree")
    return resolved


def audit_tree(path):
    path = Path(path)
    for entry in path.rglob("*"):
        if entry.is_symlink() and str(entry.resolve()).startswith("/Volumes/"):
            raise ValueError("macOS rehearsal dependency resolves onto a removable volume")


def validate(sandbox):
    args = sandbox.args
    paths = [sandbox.home, sandbox.evidence, sandbox.old, args.seed, args.assets, args.candidate_manifest]
    if getattr(args, "artifact_manifest", None):
        paths.append(args.artifact_manifest)
    if getattr(args, "rpc_tree", None):
        paths.append(args.rpc_tree)
    for name in ("launcher_artifact", "old_launcher_artifact", "connector_artifact"):
        raw = getattr(args, name, "")
        if raw:
            paths.append(raw)
            artifact = json.loads(Path(raw).read_text())
            paths.append(artifact["runtimeDir"])
    for path in paths:
        internal(path)
    trees = {sandbox.old.resolve()}
    if getattr(args, "rpc_tree", None):
        trees.add(Path(args.rpc_tree).resolve())
    for name in ("launcher_artifact", "old_launcher_artifact", "connector_artifact"):
        raw = getattr(args, name, "")
        if raw:
            trees.add(Path(json.loads(Path(raw).read_text())["runtimeDir"]).resolve())
    for path in trees:
        audit_tree(path)
