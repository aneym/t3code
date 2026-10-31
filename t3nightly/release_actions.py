import hashlib
import json
import os
import shlex
import shutil
import socket
import sqlite3
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

from .release_assemble import assemble, stamp
from .release_approval import approved
from .release_continuation import require_studio_proof
from .build_artifacts import tree_digest
from .install_offbox import REMOTE_ROOT
from .release_graph import SUCCESS_OUTCOMES
from .release_land_receipts import publish as publish_landings
from .release_manifest import digest, eligible, freeze, history_digest, load
from .release_outputs import fast_evidence
from .release_ownership import ownership
from .release_readiness import readiness
from .release_rollback_proof import fast_rollback_proof, required
from .release_seed_remotes import seed
from .release_transport import command, git_tree, prepare_remote, remote_worker, require, transfer
from .release_windows import WINDOWS_STAGES, run_windows


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
        transfer(str(config.run / "shots") + "/", f"{config.linux_host}:{config.remote_run}/shots/", log)
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
    if tree.exists():
        require(["git", "-C", str(tree), "checkout", "-q", "--detach", "--force", base], log)
        require(["git", "-C", str(tree), "clean", "-fdq"], log)
        ownership("lease", tree, log)
    else:
        git_tree(config.repo, tree, base, log)
    try:
        for name, sha in zip(config.topic.split(","), ready["topicShas"]):
            message = f"Merge {name} at {sha}\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"
            require(["git", "-C", str(tree), "merge", "--no-ff", "-m", message, sha], log)
        head = subprocess.run(["git", "-C", str(tree), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        stamp(tree, config.version)
        manifest = freeze(tree, ready.get("servingHead") or base, config.version, config.run, ready["oldReleases"], config.tools, ready.get("servingHeads"))
        if not eligible(manifest):
            log.write(f"fast path refused: { {host: target['compatibility']['fastPath']['reasons'] for host, target in manifest['targets'].items()} }\n")
            return 3
        (config.run / "assembly.json").write_text(json.dumps({"base": base, "head": head, "topics": config.topic.split(","), "topicShas": ready["topicShas"]}, indent=2) + "\n")
        bundle = config.run / "candidate.bundle"
        require(["git", "-C", str(tree), "bundle", "create", str(bundle), "HEAD", f"^v{config.nightly}"], log)
        remote = config.on("ax42").run
        names = ("candidate.json", "assembly.json", "candidate.bundle", "readiness.json")
        require(["rsync", "-a", f"--rsync-path=mkdir -p {shlex.quote(str(remote))}/receipts && rsync", "--",
                 *(str(config.run / name) for name in names), f"{config.linux_host}:{remote}/"], log)
        return 0
    finally:
        ownership("release", tree, log)


def fast_prepare(config, log):
    manifest = load(config.manifest)
    old = manifest["targets"][config.host]["oldRelease"]
    runtime = config.home / ".t3/runtime/versions" / old
    history = manifest["targets"][config.host]["compatibility"]["baseMigrations"]["history"]
    seed_path = config.seed(history)
    with closing(sqlite3.connect(f"file:{seed_path}?mode=ro", uri=True)) as connection:
        if history_digest(connection.execute("SELECT migration_id, name FROM effect_sql_migrations")) != history:
            raise ValueError(f"seed {seed_path} does not carry the base migration history")
    if not (runtime / "t3").is_file():
        raise ValueError(f"old runtime missing: {runtime}")
    root = config.sandbox_root()
    if root.exists():
        raise ValueError(f"rehearsal sandbox already allocated: {root}")
    root.mkdir(parents=True, mode=0o700)
    if sys.platform == "darwin":
        clone = root / "old-runtime" / old
        clone.parent.mkdir(mode=0o700)
        subprocess.run(["cp", "-c", "-R", str(runtime), str(clone)], check=True, timeout=120)
        runtime = clone
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    plan = {"oldRuntime": str(runtime), "seed": str(seed_path), "home": str(root / "home"), "evidence": str(root / "evidence"),
            "label": f"t3-rehearsal-fast-{config.number}-{config.host}-{uuid.uuid4().hex[:8]}", "port": port, "oldRelease": old}
    (config.run / f"sandbox-{config.host}.json").write_text(json.dumps(plan, indent=2) + "\n")
    log.write(json.dumps(plan) + "\n")
    return 0


def fast_rehearse(config, log):
    plan = json.loads((config.run / f"sandbox-{config.host}.json").read_text())
    code = command([sys.executable, str(config.tools / "rehearse"), "--old-runtime", plan["oldRuntime"], "--candidate-manifest", str(config.manifest),
                    "--assets", str(config.build_out()), "--artifact-manifest", str(config.artifact()), "--seed", plan["seed"],
                    "--home", plan["home"], "--evidence", plan["evidence"], "--label", plan["label"], "--port", str(plan["port"]),
                    "--target-host", config.host, "--provider-binary", str(config.home / ".local/bin/claude"), "--health-s", "300",
                    "--hot-swap", "--rpc-tree", str(config.tree("mac-cli" if config.host == "studio" else "linux-cli")),
                    *config.service_artifacts(), *config.target_artifacts()], log)
    if not code:
        config.receipt("rehearsal").parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(plan["evidence"]) / "rehearsal-receipt.json", config.receipt("rehearsal"))
    return code


def fast_e2e(config, log):
    tree = config.tree("mac-cli" if config.host == "studio" else "linux-cli")
    return command([sys.executable, str(config.tools / "smoke"), "--archive", str(config.build_out() / config.archive()),
                    "--version", config.version, "--out", str(config.run / f"e2e-{config.host}"), "--tree", str(tree)], log)


def fast_install(config, log):
    config.install_state().mkdir(parents=True, exist_ok=True)
    state, env, prefix = config.install_state(), None, []
    if config.host == "ax42":
        backups = (config.home / ".t3nightly" / "backups").resolve()
        state = backups.parent / "fast-install" / config.version
        state.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "AGENT_LANE": "t3-nightly", "AGENT_THREAD_ID": "mcp:a2795f2f-43aa-40c5-890c-98de1291379a"}
        prefix = ["ionice", "-c3"]
    words = [*prefix, sys.executable, str(config.tools / "install"), "--seamless", "--rpc-tree", str(config.tree("mac-cli" if config.host == "studio" else "linux-cli")), "--version", config.version, "--assets", str(config.build_out()),
             "--manifest", str(config.manifest), "--artifact-manifest", str(config.artifact()), "--receipt", str(config.receipt("rehearsal")),
             "--receipt-host", config.host, "--install-receipt", str(config.receipt("install")), "--state-dir", str(state),
             "--chat-project", str(config.chat_project()), "--load-max", "64", "--health-s", "300", "--override-reason", config.override_reason,
             "--smoke-verdict", str(config.run / f"e2e-{config.host}" / "smoke-verdict.json"), "--rollback-proof", str(config.receipt("rollback-proof"))]
    if config.host == "ax42":
        words.extend(["--service-label", "t3code.service", "--backups", str(backups), "--offbox", f"studio:{REMOTE_ROOT}/ax42", "--offbox-stage", "/srv/cow/t3nightly-offbox-stage"])
        if load(config.manifest)["targets"][config.host]["compatibility"].get("eligibility") == "restore-rollback":
            words.extend(["--offbox-stop-s", "900"])
    words.extend(config.target_artifacts())
    config.receipt("install").unlink(missing_ok=True)
    code = command(words, log, env=env)
    outcome = "failed"
    if config.receipt("install").is_file():
        outcome = json.loads(config.receipt("install").read_text())["outcome"]
    if code and outcome in SUCCESS_OUTCOMES:
        outcome = "failed"
    (config.outcome()).write_text(json.dumps({"outcome": outcome, "installerExit": code}) + "\n")
    return 0


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
    remote, local = config.on("ax42"), config.run / "ax42"
    local.mkdir(exist_ok=True)
    proof = (remote.receipt("rollback-proof"),) if required(load(config.manifest), "ax42") else ()
    for path in (remote.build_out() / remote.archive(), remote.artifact(), remote.manifest, remote.receipt("rehearsal"), remote.receipt("install"), *proof):
        transfer(f"{config.linux_host}:{path}", str(local) + "/", log)
    publish = config.run / "publish"
    publish.mkdir(exist_ok=True)
    rows = []
    for source in (config.build_out() / config.archive(), local / remote.archive()):
        target = publish / source.name
        target.unlink(missing_ok=True)
        shutil.copy2(source, target)
        rows.append(f"{hashlib.file_digest(target.open('rb'), 'sha256').hexdigest()}  {target.name}\n")
    (publish / "SHA256SUMS").write_text("".join(rows))
    code = command([sys.executable, str(config.tools / "publish-feed"), str(publish), "--desktop-dir", str(config.run / "desktop"),
                    "--feed-dir", "/Volumes/StudioExt/t3nightly-feed", "--fast-evidence", str(config.run), "--override-reason", config.override_reason], log)
    if code:
        return code
    evidence = fast_evidence(config.run, config.version)
    final = {"published": config.version, "evidence": evidence, "evidenceDigest": digest(evidence)}
    (config.run / "final-receipt.json").write_text(json.dumps(final, indent=2) + "\n")
    return 0


def fast_advisory(config, log):
    out = config.run / "advisory"
    tree = config.tree("mac-cli")
    words = [sys.executable, str(config.tools / "suite-plan"), "--tree", str(tree), "--out", str(out / "plan.json")]
    if not (out / "plan.json").is_file() and command(words, log):
        return 1
    jobs = json.loads((out / "plan.json").read_text())["jobs"]

    def one(job):
        target = out / (job["id"].replace("/", "-") + ".json")
        with (out / (target.stem + ".log")).open("a") as handle:
            return command([sys.executable, str(config.tools / "suite-worker"), "--plan", str(out / "plan.json"), "--job", job["id"],
                            "--host", job["hosts"][0], "--linux-host", config.linux_host, "--out", str(target)], handle)

    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        codes = list(pool.map(one, jobs))
    (out / "summary.json").write_text(json.dumps({"jobs": len(jobs), "passed": codes.count(0), "notPassed": len(codes) - codes.count(0)}) + "\n")
    return 0 if not any(codes) else 1


def fast_health(config, log):
    def one(host):
        with (config.run / f"health-{host}.log").open("a") as handle:
            return command([sys.executable, str(config.tools / "release-observe"), "--host", host, "--expected-version", config.version,
                            "--linux-host", config.linux_host, "--out", str(config.run / "health" / host)], handle)

    with ThreadPoolExecutor(max_workers=2) as pool:
        return max(pool.map(one, ("studio", "ax42")))


def run_fast_action(stage, config, log):
    head = json.loads((config.run / "assembly.json").read_text())["head"] if stage not in ("Q", "A") else None
    if stage == "Q":
        return readiness(config, log)
    if stage == "A":
        return fast_assemble(config, log)
    if stage == "M":
        temporary = config.tree("mac-cli").parent / ".aneym-fast-mac-tmp"
        shutil.rmtree(temporary, ignore_errors=True)
        temporary.mkdir(parents=True)
        env = dict(os.environ, T3NIGHTLY_MAC_SIGN="1", T3NIGHTLY_TMP=str(temporary))
        return fast_build(config, "mac-cli", head, config.build_out(), "build-cli", log, env)
    if stage == "L":
        require(["git", "-C", str(config.repo), "fetch", str(config.run / "candidate.bundle"), "HEAD"], log)
        return fast_build(config, "linux-cli", head, config.build_out(), "build-cli", log)
    if stage == "D":
        return fast_build(config, "desktop", head, config.run / "desktop", "build-desktop", log)
    if stage in ("PM", "PL"):
        return fast_prepare(config, log)
    if stage in ("RM", "RL"):
        return fast_rehearse(config, log)
    if stage in ("EM", "EL"):
        return fast_e2e(config, log)
    if stage in ("XM", "XL"):
        return fast_rollback_proof(config, log)
    if stage in ("IM", "IL"):
        return fast_install(config, log)
    if stage == "S":
        return fast_swap(config, log)
    if stage == "F":
        return fast_publish(config, log)
    if stage in WINDOWS_STAGES:
        return run_windows(stage, config, head, log)
    if stage == "LR":
        publish_landings(config, log)
        return 0
    if stage == "LM":
        return command([str(config.home / ".local/bin/t3-link-mesh"), "--json"], log)
    if stage == "H":
        return fast_health(config, log)
    if stage == "AS":
        return fast_advisory(config, log)
    raise ValueError(f"unknown fast stage: {stage}")
