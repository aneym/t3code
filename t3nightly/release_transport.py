import json
import os
import shlex
import subprocess
from pathlib import Path

from .release_ownership import ownership, verify_tree


def command(words, log, cwd=None, env=None):
    return subprocess.run(words, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, check=False).returncode


def require(words, log, cwd=None):
    code = command(words, log, cwd)
    if code:
        raise RuntimeError(f"command failed ({code}): {words[0]}")


def ssh(words, log):
    return command(["ssh", "-o", "BatchMode=yes", "ax42", shlex.join([str(word) for word in words])], log)


def remote_disk_free(log):
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "ax42", "df -Pk /"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        log.write(result.stderr)
        raise RuntimeError("unable to check ax42 disk space")
    rows = result.stdout.splitlines()
    if len(rows) < 2:
        raise RuntimeError("invalid ax42 disk space response")
    fields = rows[-1].split()
    try:
        return int(fields[3]) * 1024
    except (IndexError, ValueError) as error:
        raise RuntimeError("invalid ax42 disk space response") from error


def remote_worker(config, action, log):
    seed = os.environ.get("T3NIGHTLY_GATE_SEED") if action == "gate" else None
    prefix = ["env", f"T3NIGHTLY_GATE_SEED={seed}"] if seed else []
    return ssh(prefix + [
        "python3", f"{config.remote_root}/tools/release-worker", action,
        "--repo", config.remote_repo, "--tree", config.remote_tree,
        "--run", config.remote_run, "--version", config.version,
    ], log)


def transfer(source, destination, log, *, metadata_only=False):
    filters = ["--include=*.json", "--include=*.jsonl", "--include=*.log", "--exclude=*"] if metadata_only else []
    require(["rsync", "-a", *filters, "--", str(source), str(destination)], log)


def prepare_remote(config, log):
    assembly = json.loads((config.run / "assembly.json").read_text())
    bundle = config.run / "candidate.bundle"
    tag = "v" + config.version.split(".aneym.", 1)[0]
    require(["git", "bundle", "create", str(bundle), "HEAD", f"^{tag}"], log, config.candidate)
    if ssh(["mkdir", "-p", config.remote_run], log):
        return 1
    transfer(str(config.tools) + "/", f"ax42:{config.remote_root}/tools/", log)
    transfer(bundle, f"ax42:{config.remote_run}/candidate.bundle", log)
    (config.run / "candidate-head").write_text(assembly["head"] + "\n")
    transfer(config.run / "candidate-head", f"ax42:{config.remote_run}/candidate-head", log)
    return remote_worker(config, "build", log)


def git_tree(repo, tree, head, log, owned=None):
    tree = Path(tree)
    if tree.exists():
        verify_tree(tree, head)
    else:
        tree.parent.mkdir(parents=True, exist_ok=True)
        require(["git", "-C", str(repo), "worktree", "add", "--detach", str(tree), head], log)
        verify_tree(tree, head)
    ownership("lease", tree, log)
    if owned is not None:
        owned[tree] = head
