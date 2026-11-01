CLEANUP = r'''
import os
import shutil
import subprocess
import sys
from pathlib import Path

repo, requested = sys.argv[1:]
alias = Path(requested)
tree = alias.resolve()
ancestors = {os.getpid()}
pid = os.getppid()
while pid > 1:
    ancestors.add(pid)
    try:
        pid = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
    except OSError:
        break
if Path("/proc").is_dir():
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or int(proc.name) in ancestors:
            continue
        try:
            cwd = (proc / "cwd").resolve()
            args = (proc / "cmdline").read_bytes().decode(errors="replace")
            if cwd == tree or tree in cwd.parents or str(alias) in args or str(tree) in args:
                raise RuntimeError(f"advisory worktree still in use by pid {proc.name}: {tree}")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
listing = subprocess.run(["git", "-C", repo, "worktree", "list", "--porcelain"], capture_output=True, text=True, check=True).stdout
record = next((part for part in listing.split("\n\n") if part and Path(part.splitlines()[0].removeprefix("worktree ")).resolve() == tree), "")
branch = next((line.removeprefix("branch refs/heads/") for line in record.splitlines() if line.startswith("branch refs/heads/")), None)
if branch in ("main", "master"):
    raise RuntimeError(f"refusing to remove default branch {branch}")
if record:
    subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", str(tree)], check=True)
if tree.exists():
    if not tree.name.startswith("advisory-") or (tree / ".git").exists() or any(child.name not in ("node_modules", ".advisory-tmp") for child in tree.iterdir()):
        raise RuntimeError(f"refusing to remove unregistered non-residual directory: {tree}")
    shutil.rmtree(tree)
if alias.is_symlink():
    alias.unlink()
if branch:
    subprocess.run(["git", "-C", repo, "branch", "-d", branch], check=True)
subprocess.run(["git", "-C", repo, "worktree", "prune"], check=True)
print(f"removed advisory worktree: {requested}")
'''
