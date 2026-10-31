import hashlib
import json
import socket
import sys
from pathlib import Path

from .release_manifest import identity_digest, load
from .release_transport import command


def required(manifest, host):
    return manifest["targets"][host]["compatibility"].get("rollbackProof") == "required"


def legacy_launcher(installer):
    steps = {step.get("step") for step in installer.get("steps", [])}
    return installer.get("hotSwap", {}).get("method") == "hot-swap-unsupported" and "hot-swap-unsupported" in steps


def hard_rolled_back(installer):
    return legacy_launcher(installer) and installer.get("outcome") == "rolled-back" and any(step.get("step") == "hard-binary-rollback" for step in installer.get("steps", []))


def proven(path, manifest, archive_sha):
    try:
        receipt = json.loads(Path(path).read_text())
    except (OSError, TypeError, ValueError):
        return False
    installer = receipt.get("proof", {}).get("installer", {})
    method = installer.get("hotSwap", {}).get("method")
    rollback = installer.get("hotSwap", {}).get("rollback")
    swapped = (method == "launcher-ipc" and rollback == "launcher-ipc") or hard_rolled_back(installer)
    return swapped and receipt.get("result") == "ROLLBACK-PROOF" and receipt.get("manifest") == identity_digest(manifest) and receipt.get("archive") == archive_sha


def fast_rollback_proof(config, log):
    manifest = load(config.manifest)
    if not required(manifest, config.host):
        log.write("rollback proof not required\n")
        return 0
    plan = json.loads((config.run / f"sandbox-{config.host}.json").read_text())
    root = config.home / ".t3nightly" / f"rehearsal-fast-{config.number}-rollback-{config.host}"
    if root.exists():
        raise ValueError(f"rollback sandbox already allocated: {root}")
    root.mkdir(parents=True, mode=0o700)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    code = command([sys.executable, str(config.tools / "rehearse"), "--old-runtime", plan["oldRuntime"], "--candidate-manifest", str(config.manifest),
                    "--assets", str(config.build_out()), "--artifact-manifest", str(config.artifact()), "--seed", plan["seed"],
                    "--home", str(root / "home"), "--evidence", str(root / "evidence"), "--label", f"{plan['label']}-rollback", "--port", str(port),
                    "--target-host", config.host, "--provider-binary", str(config.home / ".local/bin/claude"), "--health-s", "300", "--force-rollback",
                    "--hot-swap", "--rpc-tree", str(config.tree("mac-cli" if config.host == "studio" else "linux-cli")),
                    *config.service_artifacts(), *config.target_artifacts()], log)
    result = json.loads((root / "evidence" / "result.json").read_text())
    installer = result.get("hotSwap", {}).get("install", {})
    if code or result.get("result") != "ROLLBACK-PROOF" or not (installer.get("hotSwap", {}).get("method") == "launcher-ipc" or hard_rolled_back(installer)):
        return code or 1
    receipt = {"result": result["result"], "manifest": identity_digest(manifest), "archive": hashlib.sha256((config.build_out() / config.archive()).read_bytes()).hexdigest(),
               "proof": json.loads(Path(result["proof"]).read_text()), "timings": result.get("timings")}
    config.receipt("rollback-proof").parent.mkdir(parents=True, exist_ok=True)
    config.receipt("rollback-proof").write_text(json.dumps(receipt, indent=2) + "\n")
    return 0
