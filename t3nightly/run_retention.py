import argparse
import fcntl
import json
import os
import re
import shlex
import stat
import subprocess
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from t3nightly.rehearsal_retention import ancestors, held, ignorable, live_references
    from t3nightly.release_readiness import serving_version
else:
    from .rehearsal_retention import ancestors, held, ignorable, live_references
    from .release_readiness import serving_version

VERSION = re.compile(r"(\d+\.\d+\.\d+-nightly\.\d+\.\d+\.aneym\.\d+)(?:-attempt\d+)?")
RECEIPTS = {".json", ".md", ".log", ".jsonl"}
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def version_key(version):
    return tuple(int(part) for part in re.findall(r"\d+", version))


def open_directory(path):
    path = Path(os.path.abspath(path))
    descriptor = os.open(path.anchor, DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, DIRECTORY, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def references():
    values, uncertain = live_references()
    if sys.platform == "darwin":
        result = subprocess.run(["lsof", "-nP", "-u", str(os.getuid()), "-Fpn"], capture_output=True, text=True, check=True, timeout=60)
        pid = None
        for line in result.stdout.splitlines():
            if line.startswith("p"):
                pid = line[1:]
            elif line.startswith("n") and pid != str(os.getpid()):
                values.append(line[1:])
    else:
        lineage = ancestors()
        for proc in Path("/proc").iterdir():
            if not proc.name.isdigit() or proc.name == str(os.getpid()):
                continue
            try:
                if proc.stat().st_uid != os.getuid():
                    continue
                values.append(os.readlink(proc / "exe"))
                for entry in (proc / "fd").iterdir():
                    try:
                        values.append(os.readlink(entry))
                    except FileNotFoundError:
                        pass
                for line in (proc / "maps").read_text().splitlines():
                    fields = line.split(maxsplit=5)
                    if len(fields) == 6:
                        values.append(fields[5])
            except FileNotFoundError:
                continue
            except PermissionError:
                if not ignorable(proc, lineage):
                    uncertain.append(proc.name)
    return values, uncertain


EVIDENCE = (".png", ".jpg", ".jpeg", ".webm", ".mp4", ".yml", ".yaml", ".txt", ".html")


def bulk(parts):
    return (
        parts[-1].endswith((".tar.gz", ".bundle"))
        or any(name.startswith("rehearsal-") and parts[index + 1:index + 2] == ("home",) for index, name in enumerate(parts[:-1]))
        or any(parts[index:index + 3] == ("evidence", "installer-state", "rollback-runtime") for index in range(len(parts)))
        or (any(name == "e2e" or name.startswith("e2e-") for name in parts[:-1]) and not parts[-1].endswith(EVIDENCE))
    )


def sweep(descriptor, parts, report, dry_run, device):
    for entry in sorted(os.scandir(descriptor), key=lambda item: item.name):
        info = entry.stat(follow_symlinks=False)
        relative = (*parts, entry.name)
        if info.st_dev != device or stat.S_ISLNK(info.st_mode):
            continue
        if stat.S_ISDIR(info.st_mode):
            child = os.open(entry.name, DIRECTORY, dir_fd=descriptor)
            try:
                sweep(child, relative, report, dry_run, device)
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode) and Path(entry.name).suffix.lower() not in RECEIPTS and bulk(relative):
            row = {"path": "/".join(relative), "bytes": info.st_size}
            if not dry_run:
                os.unlink(entry.name, dir_fd=descriptor)
            report["removed"].append(row)
            report["bytes"] += info.st_size


def retain(root, active_run, *, dry_run=False):
    root = Path(os.path.abspath(root))
    active = Path(os.path.abspath(active_run))
    if not active.is_relative_to(root) or active == root:
        raise ValueError("active run must be inside run root")
    active_name = active.relative_to(root).parts[0]
    report = {"dryRun": dry_run, "root": str(root), "activeRun": active_name, "kept": [], "held": [], "removed": [], "bytes": 0}
    descriptor = open_directory(root)
    try:
        lock = os.open(".run-retention.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        with os.fdopen(lock, "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            serving = serving_version()
            report["serving"] = serving
            dirs = [entry.name for entry in os.scandir(descriptor) if entry.is_dir(follow_symlinks=False)]
            versions = {name: match[1] for name in dirs if (match := VERSION.fullmatch(name))}
            if not isinstance(serving, str) or VERSION.fullmatch(serving) is None or serving not in versions.values():
                report["skipped"] = "serving version unavailable or absent from runs"
            else:
                previous = sorted({value for value in versions.values() if version_key(value) < version_key(serving)}, key=version_key)[-2:]
                keep = {serving, *previous}
                report["protectedVersions"] = sorted(keep, key=version_key)
                values, uncertain = references()
                report["uncertainProcesses"] = len(uncertain)
                for name in sorted(dirs):
                    version = versions.get(name)
                    if name == active_name or version is None or version in keep or version_key(version) >= version_key(serving):
                        report["kept"].append(name)
                    elif uncertain or held({str(root / name), str(Path.home() / ".t3nightly/runs" / name)}, values):
                        report["held"].append(name)
                    else:
                        child = os.open(name, DIRECTORY, dir_fd=descriptor)
                        try:
                            sweep(child, (name,), report, dry_run, os.fstat(descriptor).st_dev)
                        finally:
                            os.close(child)
            report_fd = os.open("run-retention.json", os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
            with os.fdopen(report_fd, "w") as output:
                output.write(json.dumps(report, indent=2) + "\n")
    finally:
        os.close(descriptor)
    return report


def finish_runs(run, remote_run, remote_tools, *, dry_run=False, linux_host="ax42"):
    run = Path(run)
    local_root = run.parent.parent if run.name.startswith("fast") else run.parent
    remote = Path(remote_run)
    remote_root = remote.parent.parent if remote.name.startswith("fast") else remote.parent
    results = {}
    try:
        results["studio"] = retain(local_root, run, dry_run=dry_run)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        results["studio"] = {"error": str(error)}
    command = ["python3", str(Path(remote_tools) / "run_retention.py"), "--root", str(remote_root), "--active-run", str(remote)]
    if dry_run:
        command.append("--dry-run")
    try:
        command = ["env", f"PYTHONPATH={Path(remote_tools).parent}", *command]
        result = subprocess.run(["ssh", "-o", "BatchMode=yes", linux_host, shlex.join(command)], capture_output=True, text=True, check=True, timeout=180)
        results["ax42"] = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        results["ax42"] = {"error": str(error)}
    descriptor = open_directory(run)
    try:
        fd = os.open("run-retention.json", os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        with os.fdopen(fd, "w") as output:
            output.write(json.dumps(results, indent=2) + "\n")
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description="Retire regenerable run bulk, preserving receipts and serving history")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--active-run", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(retain(args.root, args.active_run, dry_run=args.dry_run), indent=2))


if __name__ == "__main__":
    main()
