import hashlib
import json
import os
from pathlib import Path

from .release_assemble import assemble, stamp
from .release_approval import require_approval
from .release_continuation import require_studio_proof
from .release_seed_remotes import seed
from .release_transport import command, git_tree, prepare_remote, remote_worker, transfer


def approved(config):
    try:
        require_approval(config.version, config.verdict, config.run / "shots")
        return True
    except ValueError:
        return False


def checksums(config):
    paths = [config.run / config.archive(platform) for platform in ("darwin-arm64", "linux-x64")]
    rows = []
    for path in paths:
        with path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        rows.append(f"{digest}  {path.name}\n")
    (config.run / "SHA256SUMS").write_text("".join(rows))


def local_tree(config, stage, log):
    head = json.loads((config.run / "assembly.json").read_text())["head"]
    tree = config.tree(stage)
    git_tree(config.repo, tree, head, log, config.owned_trees)
    stamp(tree, config.version)
    return tree


def run_action(stage, config, log):
    tools = config.tools
    if stage == "assemble":
        return assemble(config, log)
    if stage == "mac-cli":
        tree = local_tree(config, "mac-cli", log)
        env = dict(os.environ, T3NIGHTLY_MAC_SIGN="1", T3NIGHTLY_TMP=str(tree / ".local-release/tmp"))
        Path(env["T3NIGHTLY_TMP"]).mkdir(parents=True, exist_ok=True)
        return command([str(tools / "build-cli"), "--tree", str(tree), "--version", config.version, "--out", str(config.run)], log, env=env)
    if stage == "desktop":
        tree = local_tree(config, "desktop", log)
        return command([str(tools / "build-desktop"), "--tree", str(tree), "--version", config.version, "--out", str(config.run / "desktop")], log)
    if stage == "linux-cli":
        code = prepare_remote(config, log)
        if not code:
            transfer(f"ax42:{config.remote_run}/{config.archive('linux-x64')}", str(config.run) + "/", log)
        return code
    if stage == "gate":
        code = remote_worker(config, "gate", log)
        for folder in ("gate", "suite"):
            transfer(f"ax42:{config.remote_run}/{folder}", str(config.run) + "/", log)
        return code
    if stage == "stage-review":
        return command([str(tools / "stage-review"), "--worktree", str(config.tree("mac-cli")), "--out", str(config.run / "shots")], log)
    if stage == "awaiting-verdict":
        if not approved(config):
            print(f"awaiting-verdict: lead must approve {config.verdict}; rerun to resume", flush=True)
            log.write(f"awaiting approval at {config.verdict}\n")
            return 10
        checksums(config)
        return 0
    if not approved(config):
        raise RuntimeError("visual approval is missing or was revoked")
    if stage == "studio-continuation-proof":
        try:
            path = require_studio_proof(config)
        except (OSError, ValueError, KeyError, TypeError) as error:
            log.write(f"Studio continuation proof pending: {error}\n")
            return 10
        log.write(f"Approved real Studio continuation proof: {path}\n")
        return 0
    if stage == "install-ax42":
        transfer(config.verdict, f"ax42:{config.remote_run}/visual-verdict.md", log)
        transfer(str(config.run / "shots") + "/", f"ax42:{config.remote_run}/shots/", log)
        transfer(config.run / "SHA256SUMS", f"ax42:{config.remote_run}/SHA256SUMS", log)
        transfer(str(Path(config.verdict).parent / "smoke") + "/", f"ax42:{config.remote_run}/smoke/", log)
        code = remote_worker(config, "install", log)
        if not code:
            destination = config.run / "ax42-install"
            destination.mkdir(exist_ok=True)
            transfer(f"ax42:{config.remote_run}/install/", str(destination) + "/", log, metadata_only=True)
            (destination / "remote-payloads.json").write_text(json.dumps({
                "retained_on": "ax42", "directory": f"{config.remote_run}/install",
                "copied": "JSON receipts and logs only; database payloads remain on ax42",
            }, indent=2) + "\n")
        return code
    if stage == "install-studio":
        args = [str(tools / "install"), "--version", config.version, "--assets", str(config.run), "--verdict", str(config.verdict), "--state-dir", str(config.run / "studio-install"), "--merge-repo", "/Volumes/StudioExt/repos/agent-rails"]
        owner = json.loads((config.lane / "lane.json").read_text()).get("t3", {})
        if owner.get("host") == "studio" and owner.get("thread_id"):
            args.extend(["--ignore-thread", owner["thread_id"]])
        args.extend(["--load-max", "8", "--wait"])
        if not (Path.home() / ".t3nightly/launcher-granted").exists():
            args.append("--no-pin-launcher")
        return command(args, log)
    if stage == "seed-remote-runtimes":
        return seed(config, log, dry_run=os.environ.get("T3NIGHTLY_DRY_RUN") == "1")
    if stage == "desktop-swap":
        code = command([str(tools / "desktop-swap"), str(config.run / "desktop" / f"T3-Code-{config.version}-arm64.zip"), "--verdict", str(config.verdict)], log)
        if not code:
            print("Desktop installed; quit and reopen T3 Dev yourself. The driver does not quit apps.", flush=True)
        return code
    if stage == "publish-feed":
        return command([str(tools / "publish-feed"), str(config.run), "--desktop-dir", str(config.run / "desktop"), "--feed-dir", str(config.feed), "--verdict", str(config.verdict)], log)
    raise ValueError(f"unknown stage: {stage}")
