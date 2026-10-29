import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

DEFAULT_CACHE = Path("/Volumes/StudioExt/repos/t3code-rr-cache")
SCRATCH_ROOT = Path("/Volumes/StudioExt/tmp")


def run(repo, *words, check=True):
    return subprocess.run(
        ["git", "-C", str(repo), *words],
        text=True,
        capture_output=True,
        check=check,
    )


def newest_tag(repo, pattern):
    result = run(repo, "tag", "--sort=-version:refname", "-l", pattern)
    return result.stdout.splitlines()[0] if result.stdout.splitlines() else None


def configure_rerere(worktree, cache):
    cache.mkdir(parents=True, exist_ok=True)
    common_dir = Path(run(worktree, "rev-parse", "--git-common-dir").stdout.strip())
    if not common_dir.is_absolute():
        common_dir = Path(worktree) / common_dir
    link = common_dir / "rr-cache"
    if link.exists() or link.is_symlink():
        if link.is_symlink() and link.resolve() == cache.resolve():
            pass
        elif link.is_dir():
            for item in link.iterdir():
                target = cache / item.name
                if not target.exists():
                    shutil.copytree(item, target)
            shutil.rmtree(link)
        else:
            link.unlink()
    if not link.exists():
        link.symlink_to(cache, target_is_directory=True)
    run(worktree, "config", "rerere.enabled", "true")
    run(worktree, "config", "rerere.autoUpdate", "true")
    run(worktree, "config", "--unset", "rerere.dir", check=False)
    return str(cache.resolve())


def sync_cache(cache, host):
    remote = f"{host}:/home/jobs/repos/t3code-rr-cache/"
    subprocess.run(["ssh", host, "mkdir", "-p", "/home/jobs/repos/t3code-rr-cache"], check=True)
    subprocess.run(
        ["rsync", "-a", "--update", f"{remote}", f"{cache.resolve()}/"],
        check=True,
    )
    subprocess.run(
        ["rsync", "-a", "--update", f"{cache.resolve()}/", remote],
        check=True,
    )


def ensure_branch_worktree(repo, branch, base):
    result = subprocess.run(
        [
            "lane-worktree", "ensure", "--repo", str(repo), "--branch", branch,
            "--base", base, "--json",
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    data = json.loads(result.stdout)
    return Path(data["path"])


def merge_trial(repo, branch, tag, cache, dry_run, base_branch):
    parent = run(repo, "rev-parse", base_branch).stdout.strip()
    worktree = None
    temporary = None
    if dry_run:
        SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="t3-fork-sync-", dir=SCRATCH_ROOT)
        worktree = Path(temporary.name)
        run(repo, "worktree", "add", "--detach", str(worktree), parent)
    else:
        if run(repo, "show-ref", "--verify", f"refs/heads/{branch}", check=False).returncode != 0:
            raise ValueError(f"branch does not exist: {branch}; pass --base to choose a source")
        worktree = ensure_branch_worktree(repo, branch, base_branch)
    try:
        configured = configure_rerere(worktree, cache)
        result = run(worktree, "merge", "--no-edit", "--no-ff", tag, check=False)
        conflicts = run(worktree, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
        rerere_files = run(worktree, "rerere", "status").stdout.splitlines()
        merging = run(worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False).returncode == 0
        if result.returncode == 0:
            outcome = "merged"
        elif conflicts:
            outcome = "conflicts"
        elif merging and rerere_files:
            outcome = "rerere-resolved"
            if not dry_run:
                run(worktree, "commit", "--no-edit")
        else:
            outcome = "failed"
        output = {
            "outcome": outcome,
            "tag": tag,
            "branch": branch,
            "conflicts": conflicts,
            "rerereResolved": rerere_files,
            "rrCache": configured,
        }
        if dry_run:
            run(worktree, "merge", "--abort", check=False)
        return output
    finally:
        if dry_run and worktree:
            run(repo, "worktree", "remove", "--force", str(worktree), check=False)
            if temporary:
                temporary.cleanup()


def parser():
    value = argparse.ArgumentParser(description="Sync the long-lived fork with upstream nightly tags.")
    value.add_argument("--repo", type=Path, default=Path("/Volumes/StudioExt/repos/t3code"))
    value.add_argument("--branch", default="aneym/fork")
    value.add_argument("--upstream", default="upstream")
    value.add_argument("--tag-pattern", default="v*-nightly.*")
    value.add_argument("--rr-cache", type=Path, default=DEFAULT_CACHE)
    value.add_argument("--dry-run", action="store_true")
    value.add_argument("--sync-host")
    value.add_argument("--no-fetch", action="store_true")
    value.add_argument("--base")
    return value


def main():
    args = parser().parse_args()
    repo = args.repo.resolve()
    if not args.no_fetch:
        subprocess.run(["git", "-C", str(repo), "fetch", args.upstream, "--tags"], check=True)
    tag = newest_tag(repo, args.tag_pattern)
    if not tag:
        raise SystemExit("no upstream nightly tag found")
    if args.base:
        base = args.base
    elif run(repo, "show-ref", "--verify", f"refs/heads/{args.branch}", check=False).returncode == 0:
        base = args.branch
    else:
        raise SystemExit(f"branch does not exist: {args.branch}; pass --base to choose a source")
    result = merge_trial(repo, args.branch, tag, args.rr_cache.resolve(), args.dry_run, base)
    print(json.dumps(result, indent=2, sort_keys=True), flush=True)
    if args.sync_host:
        sync_cache(args.rr_cache.resolve(), args.sync_host)
    return 0 if result["outcome"] in {"merged", "rerere-resolved"} else 2 if result["outcome"] == "conflicts" else 1


if __name__ == "__main__":
    raise SystemExit(main())
