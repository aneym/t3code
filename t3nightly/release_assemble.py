import json
import re
import subprocess
from pathlib import Path

from .release_ownership import ownership, verify_tree


PACKAGE_FILES = (
    "apps/server/package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
)


def git(repo, *args, log=None):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=log or subprocess.PIPE,
        stderr=subprocess.STDOUT if log else subprocess.PIPE,
        text=True,
        check=True,
    ).stdout


def read_topics(path):
    topics = []
    for number, line in enumerate(Path(path).read_text().splitlines(), 1):
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 2 or not re.fullmatch(r"[0-9a-fA-F]{7,40}", fields[1]):
            raise ValueError(f"topics line {number}: expected branch sha")
        topics.append(tuple(fields))
    return topics


def stamp(candidate, version):
    for name in PACKAGE_FILES:
        path = Path(candidate) / name
        value = json.loads(path.read_text())
        value["version"] = version
        path.write_text(json.dumps(value, indent=2) + "\n")


def assemble(config, log):
    topics = read_topics(config.topics)
    base = git(config.repo, "rev-parse", f"{config.base}^{{commit}}").strip()
    if config.candidate.exists():
        raise RuntimeError(f"unrecorded candidate already exists: {config.candidate}; inspect it before retrying")
    config.candidate.parent.mkdir(parents=True, exist_ok=True)
    git(config.repo, "worktree", "add", "--detach", str(config.candidate), base, log=log)
    verify_tree(config.candidate, base)
    ownership("lease", config.candidate, log)
    config.owned_trees[config.candidate] = base
    accepted, dropped = [], []
    for branch, sha in topics:
        before = git(config.candidate, "rev-parse", "HEAD").strip()
        message = f"Merge {branch} at {sha}\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"
        result = subprocess.run(
            ["git", "-C", str(config.candidate), "merge", "--no-ff", "-m", message, sha],
            stdout=log, stderr=subprocess.STDOUT, check=False,
        )
        if result.returncode:
            merging = git(config.candidate, "rev-parse", "--git-path", "MERGE_HEAD").strip()
            if Path(merging).exists():
                git(config.candidate, "merge", "--abort", log=log)
            if git(config.candidate, "rev-parse", "HEAD").strip() != before:
                raise RuntimeError(f"failed merge changed HEAD for {branch}")
            if git(config.candidate, "status", "--porcelain").strip():
                raise RuntimeError(f"failed merge left changes for {branch}")
            dropped.append({"branch": branch, "sha": sha, "exit": result.returncode})
        else:
            accepted.append({"branch": branch, "sha": sha})
            config.owned_trees[config.candidate] = git(config.candidate, "rev-parse", "HEAD").strip()
    head = git(config.candidate, "rev-parse", "HEAD").strip()
    stamp(config.candidate, config.version)
    (config.run / "assembly.json").write_text(json.dumps({
        "base": base, "head": head, "accepted": accepted, "dropped": dropped,
        "candidate": str(config.candidate), "version": config.version,
    }, indent=2) + "\n")
    log.write(f"assembled {head}; accepted {len(accepted)}, dropped {len(dropped)}\n")
    return 0
