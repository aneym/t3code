import hashlib
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .release_assemble import assemble, stamp
from .release_approval import approved
from .release_continuation import require_studio_proof
from .build_artifacts import tree_digest
from .release_install import fast_install
from .release_linux import prepare_dependencies, require_host_ready, stage_linux
from .release_targets import LINUX_TARGETS, stage_action, stage_target
from .release_land_receipts import publish as publish_landings
from .release_manifest import digest, eligible, freeze
from .release_outputs import deferred_hosts, fast_evidence
from .release_publish_stage import stage_payload, validate as validate_staged
from .release_ownership import ownership
from .release_readiness import readiness
from .release_seed_remotes import seed
from .release_advisory import fast_advisory
from .release_transport import command, git_tree, prepare_remote, remote_worker, require, transfer
from .release_windows import WINDOWS_STAGES, run_windows
from .assembly_lineage import missing, refusal, required, targets
from .release_ledger import LedgerRefusal, fetch_candidate, publish_candidate, read as read_ledger, record_installed, require_releases


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
            transfer(f"{config.linux_host}:{config.remote_run}/{config.archive('linux-x64')}", str(config.run) + "/", log)
        return code
    if stage == "gate":
        code = remote_worker(config, "gate", log)
        for folder in ("gate", "suite"):
            transfer(f"{config.linux_host}:{config.remote_run}/{folder}", str(config.run) + "/", log)
        return code
    if stage == "stage-review":
        return command([str(tools / "stage-review"), "--version", config.version, "--worktree", str(config.tree("mac-cli")), "--out", str(config.run / "shots")], log)
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
        transfer(config.verdict, f"{config.linux_host}:{config.remote_run}/visual-verdict.md", log)
        transfer(str(config.run / "shots") + "/", f"{config.linux_host}:{config.remote_run}/shots/", log, bulk=True)
        transfer(config.run / "SHA256SUMS", f"{config.linux_host}:{config.remote_run}/SHA256SUMS", log)
        transfer(str(Path(config.verdict).parent / "smoke") + "/", f"{config.linux_host}:{config.remote_run}/smoke/", log)
        code = remote_worker(config, "install", log)
        if not code:
            destination = config.run / "ax42-install"
            destination.mkdir(exist_ok=True)
            transfer(f"{config.linux_host}:{config.remote_run}/install/", str(destination) + "/", log, metadata_only=True)
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
        args.extend(["--load-max", "8", "--wait", "--override-reason", config.override_reason])
        if not (Path.home() / ".t3nightly/launcher-granted").exists():
            args.append("--no-pin-launcher")
        return command(args, log)
    if stage == "seed-remote-runtimes":
        return seed(config, log, dry_run=os.environ.get("T3NIGHTLY_DRY_RUN") == "1")
    if stage == "desktop-swap":
        code = command([str(tools / "desktop-swap"), str(config.run / "desktop" / f"T3-Code-{config.version}-arm64.zip"), "--verdict", str(config.verdict), "--override-reason", config.override_reason], log)
        if not code:
            print("Desktop installed; quit and reopen T3 Dev yourself. The driver does not quit apps.", flush=True)
        return code
    if stage == "publish-feed":
        return command([str(tools / "publish-feed"), str(config.run), "--desktop-dir", str(config.run / "desktop"), "--feed-dir", str(config.feed), "--verdict", str(config.verdict)], log)
    raise ValueError(f"unknown stage: {stage}")


def fast_tree(config, stage, head, log):
    tree = config.tree(stage)
    if tree.exists():
        ownership("lease", tree, log)
        require(["git", "-C", str(tree), "checkout", "-q", "--detach", "--force", head], log)
        require(["git", "-C", str(tree), "clean", "-fdq"], log)
    else:
        git_tree(config.repo, tree, head, log)
    stamp(tree, config.version)
    return tree


def fast_build(config, stage, head, out, script, log, env=None):
    tree = fast_tree(config, stage, head, log)
    try:
        return command([str(config.tools / script), "--tree", str(tree), "--version", config.version, "--out", str(out)], log, env=env)
    finally:
        ownership("release", tree, log)


def fast_assemble(config, log):
    ready = json.loads((config.run / "readiness.json").read_text())
    tree, base = config.candidate_tree(), ready["baseHead"]
    try:
        ledger = read_ledger(config.repo)
        require_releases(ledger, ready["oldReleases"].values())
    except LedgerRefusal as error:
        log.write(f"assembly refused: {error}\n")
        return 4
    log.write(f"release ledger {ledger['commit']} rows {len(ledger['rows'])}\n")
    if tree.exists():
        require(["git", "-C", str(tree), "checkout", "-q", "--detach", "--force", base], log)
        require(["git", "-C", str(tree), "clean", "-fdq"], log)
        ownership("lease", tree, log)
    else:
        git_tree(config.repo, tree, base, log)
    try:
        entries, scope = required(tree, ledger, targets(ready))
        log.write(f"assembly lineage scope {scope}\n")
        if gaps := missing(tree, ready["topicShas"], entries):
            log.write(refusal(gaps) + "\n")
            return 4
        for name, sha in zip(config.topic.split(","), ready["topicShas"]):
            message = f"Merge {name} at {sha}\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"
            require(["git", "-C", str(tree), "merge", "--no-ff", "-m", message, sha], log)
        head = subprocess.run(["git", "-C", str(tree), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        stamp(tree, config.version)
        manifest = freeze(tree, ready.get("servingHead") or base, config.version, config.run, ready["oldReleases"], config.tools, ready.get("servingHeads"), ready.get("deferredHosts", {}))
        if not eligible(manifest):
            log.write(f"fast path refused: { {host: target['compatibility']['fastPath']['reasons'] for host, target in manifest['targets'].items()} }\n")
            return 3
        ref = publish_candidate(config.repo, config.version, head)
        log.write(f"candidate {head} pushed to origin {ref}\n")
        (config.run / "assembly.json").write_text(json.dumps({"base": base, "head": head, "topics": config.topic.split(","), "topicShas": ready["topicShas"], "candidateRef": ref}, indent=2) + "\n")
        return 0
    finally:
        ownership("release", tree, log)


def fast_swap(config, log):
    archive = config.run / "desktop" / f"T3-Code-{config.version}-arm64.zip"
    code = command([sys.executable, str(config.tools / "desktop-swap"), str(archive), "--fast-evidence", str(config.run), "--override-reason", config.override_reason], log)
    if code:
        return code
    app = Path("/Applications/T3 Dev.app")
    proof = {"version": config.version, "app": str(app), "treeDigest": tree_digest(app),
             "zip": hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()}
    proof["digest"] = digest(proof)
    (config.run / "desktop-swap.json").write_text(json.dumps(proof, indent=2) + "\n")
    return 0


def fast_publish(config, log):
    remote = config.on(config.build_host)
    source = config.run / config.build_host
    deferred = deferred_hosts(config.run)
    for host, address in LINUX_TARGETS.items():
        if host in deferred:
            continue
        own, local = config.on(host), config.run / host
        local.mkdir(exist_ok=True)
        for path in (own.manifest, own.receipt("install")):
            transfer(f"{address}:{path}", str(local) + "/", log)
        if host != config.build_host:
            shutil.copy2(source / remote.artifact().name, local / remote.artifact().name)
            archive = local / remote.archive()
            archive.unlink(missing_ok=True)
            os.link(source / remote.archive(), archive)
    for stage in ("SM", "SL", "SD"):
        validate_staged(config, stage)
    publish = config.run / "publish"
    publish.mkdir(exist_ok=True)
    rows = []
    for target in (publish / config.archive(), publish / remote.archive()):
        rows.append(f"{hashlib.file_digest(target.open('rb'), 'sha256').hexdigest()}  {target.name}\n")
    (publish / "SHA256SUMS").write_text("".join(rows))
    code = command([sys.executable, str(config.tools / "publish-feed"), str(publish), "--desktop-dir", str(config.run / "desktop"),
                    "--feed-dir", "/Volumes/StudioExt/t3nightly-feed", "--fast-evidence", str(config.run)], log)
    if code:
        return code
    evidence = fast_evidence(config.run, config.version)
    final = {"published": config.version, "evidence": evidence, "evidenceDigest": digest(evidence)}
    (config.run / "final-receipt.json").write_text(json.dumps(final, indent=2) + "\n")
    return 0


def fast_health(config, log):
    def one(host):
        with (config.run / f"health-{host}.log").open("a") as handle:
            return command([sys.executable, str(config.tools / "release-observe"), "--host", host, "--expected-version", config.version,
                            "--linux-host", LINUX_TARGETS.get(host, "ax42"), "--out", str(config.run / "health" / host)], handle)

    hosts = tuple(host for host in ("studio", *LINUX_TARGETS) if host not in deferred_hosts(config.run))
    with ThreadPoolExecutor(max_workers=len(hosts)) as pool:
        return max(pool.map(one, hosts))


def run_fast_action(stage, config, log):
    target = stage_target(stage)
    stage = stage_action(stage)
    head = json.loads((config.run / "assembly.json").read_text())["head"] if stage not in ("Q", "A") else None
    if stage == "Q":
        return readiness(config, log)
    if stage == "A":
        return fast_assemble(config, log)
    if stage == "M":
        require_host_ready(config, build=True)
        temporary = config.tree("mac-cli").parent / ".aneym-fast-mac-tmp"
        shutil.rmtree(temporary, ignore_errors=True)
        temporary.mkdir(parents=True)
        env = dict(os.environ, T3NIGHTLY_MAC_SIGN="1", T3NIGHTLY_TMP=str(temporary))
        return fast_build(config, "mac-cli", head, config.build_out(), "build-cli", log, env)
    if stage == "L":
        require_host_ready(config, build=True)
        fetch_candidate(config.repo, json.loads((config.run / "assembly.json").read_text()))
        return fast_build(config, "linux-cli", head, config.build_out(), "build-cli", log)
    if stage == "D":
        return fast_build(config, "desktop", head, config.run / "desktop", "build-desktop", log)
    if stage in ("SM", "SL", "SD"):
        return stage_payload(config, stage, log)
    if stage == "stage-linux":
        return stage_linux(config, target, log)
    if stage == "install":
        prepare_dependencies(config, head, log, fast_tree)
        return fast_install(config, log) or record_installed(config, log)
    if stage == "S":
        return fast_swap(config, log)
    if stage == "F":
        return fast_publish(config, log)
    if stage in WINDOWS_STAGES:
        return run_windows(stage, config, head, log)
    if stage == "LR":
        return publish_landings(config, log)
    if stage == "LM":
        if config.defer_hosts:
            log.write(f"link-mesh skip: deferred hosts {', '.join(config.defer_hosts)}\n")
            return 0
        return command([str(config.home / ".local/bin/t3-link-mesh"), "--json"], log)
    if stage == "H":
        return fast_health(config, log)
    if stage == "AS":
        return fast_advisory(config, log)
    raise ValueError(f"unknown fast stage: {stage}")
