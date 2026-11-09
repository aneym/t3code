import argparse
import fcntl
import io
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
    from t3nightly.rehearsal_retention import APPROVAL, ancestors, holder, ignorable, live_references, nightly_root, survey
    from t3nightly.release_liveness import VERSION, live_runs, record_current
    from t3nightly.release_readiness import serving_version
    from t3nightly.remote_shell import ssh_argv
else:
    from .rehearsal_retention import APPROVAL, ancestors, holder, ignorable, live_references, nightly_root, survey
    from .release_liveness import VERSION, live_runs, record_current
    from .release_readiness import serving_version
    from .remote_shell import ssh_argv

RECEIPTS = {".json", ".md", ".log", ".jsonl"}
PACKAGES = (".tar.gz", ".bundle", ".zip", ".exe", ".dmg", ".msi", ".appimage", ".deb", ".blockmap")
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
        parts[-1].lower().endswith(PACKAGES)
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
            row = {"path": str(Path(report["root"], *relative)), "bytes": info.st_size}
            if not dry_run:
                os.unlink(entry.name, dir_fd=descriptor)
            report["removed"].append(row)
            report["bytes"] += info.st_size


def protected_versions(root, versions, serving, cite):
    reasons = {}
    for version in sorted(set(versions.values()), key=version_key)[-2:]:
        reasons.setdefault(version, "one of the last two releases")
    if isinstance(serving, str):
        reasons[serving] = "serving on this host"
    for host, version in cite.items():
        if isinstance(version, str) and VERSION.fullmatch(version):
            reasons.setdefault(version, f"current on {host}")
    for run, reason in live_runs().items():
        if run.is_relative_to(root) and run != root and (version := versions.get(run.relative_to(root).parts[0])):
            reasons.setdefault(version, f"live: {reason}")
    return reasons


def retain(root, active_run, *, dry_run=False, cite=None):
    root = Path(os.path.abspath(root))
    active = Path(os.path.abspath(active_run))
    if not active.is_relative_to(root) or active == root:
        raise ValueError("active run must be inside run root")
    active_name = active.relative_to(root).parts[0]
    report = {"approval": APPROVAL, "dryRun": dry_run, "root": str(root), "activeRun": active_name, "kept": {}, "held": {}, "removed": [], "bytes": 0}
    descriptor = open_directory(root)
    try:
        lock = os.open(".run-retention.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        with os.fdopen(lock, "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            from t3nightly.suite_store import maintain
            from t3nightly.suite_worker import HOSTS
            import socket

            host = "studio" if sys.platform == "darwin" else socket.gethostname().split(".")[0]
            if dry_run:
                log = io.StringIO()
                report["advisory"] = maintain(root, [host] if host in HOSTS else [], log, dry_run=True)
                report["advisoryLog"] = log.getvalue()
            else:
                with (active / "advisory-maintenance.log").open("a") as log:
                    report["advisory"] = maintain(root, [host] if host in HOSTS else [], log)
            serving = serving_version()
            report["serving"] = serving
            report["cited"] = dict(cite or {})
            if not dry_run:
                record_current(report["cited"])
            dirs = [entry.name for entry in os.scandir(descriptor) if entry.is_dir(follow_symlinks=False)]
            versions = {name: match[1] for name in dirs if (match := VERSION.fullmatch(name))}
            if not isinstance(serving, str) or VERSION.fullmatch(serving) is None or serving not in versions.values():
                report["skipped"] = "serving version unavailable or absent from runs"
            else:
                keep = protected_versions(root, versions, serving, report["cited"])
                report["protectedVersions"] = {version: keep[version] for version in sorted(keep, key=version_key)}
                values, uncertain = references()
                report["uncertainProcesses"] = len(uncertain)
                for name in sorted(dirs):
                    version = versions.get(name)
                    if name == active_name:
                        report["kept"][name] = "active run"
                    elif version is None:
                        report["kept"][name] = "not a release run"
                    elif version in keep:
                        report["kept"][name] = keep[version]
                    elif uncertain:
                        report["held"][name] = f"{len(uncertain)} unreadable processes"
                    elif (reference := holder({str(root / name), str(Path.home() / ".t3nightly/runs" / name)}, values)) is not None:
                        report["held"][name] = f"a running process holds it open: {reference[:160]}"
                    else:
                        child = os.open(name, DIRECTORY, dir_fd=descriptor)
                        try:
                            sweep(child, (name,), report, dry_run, os.fstat(descriptor).st_dev)
                        finally:
                            os.close(child)
            if not dry_run:
                report_fd = os.open("run-retention.json", os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
                with os.fdopen(report_fd, "w") as output:
                    output.write(json.dumps(report, indent=2) + "\n")
    finally:
        os.close(descriptor)
    if nightly_root().is_dir():
        try:
            report["rehearsals"] = survey(dry_run=dry_run, cite=cite)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            report["rehearsals"] = {"error": f"{type(error).__name__}: {error}"}
    return report


def remote_command(remote_tools, *words):
    command = ["env", f"PYTHONPATH={Path(remote_tools).parent}", "python3", str(Path(remote_tools) / "run_retention.py"), *words]
    return shlex.join(command)


def finish_runs(run, remote_run, remote_tools, *, dry_run=False, linux_host="ax42", hosts=None):
    run = Path(run)
    local_root = run.parent.parent if run.name.startswith("fast") else run.parent
    remote = Path(remote_run)
    remote_root = remote.parent.parent if remote.name.startswith("fast") else remote.parent
    hosts = hosts or {"ax42": linux_host}
    cite, results = {"studio": serving_version()}, {}
    for host, address in hosts.items():
        try:
            result = subprocess.run([*ssh_argv(address), remote_command(remote_tools, "--serving")], capture_output=True, text=True, check=True, timeout=60)
            cite[host] = json.loads(result.stdout)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            results[host] = {"error": f"serving probe: {error}"}
    try:
        results["studio"] = retain(local_root, run, dry_run=dry_run, cite=cite)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        results["studio"] = {"error": str(error)}
    words = ["--root", str(remote_root), "--active-run", str(remote), "--cite-json", json.dumps(cite), *(["--dry-run"] if dry_run else [])]
    for host, address in hosts.items():
        if host in results:
            continue
        try:
            result = subprocess.run([*ssh_argv(address), remote_command(remote_tools, *words)], capture_output=True, text=True, check=True, timeout=180)
            results[host] = json.loads(result.stdout)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            results[host] = {"error": str(error)}
    (run / "receipts").mkdir(parents=True, exist_ok=True)
    descriptor = open_directory(run / "receipts")
    try:
        fd = os.open("run-retention.json", os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        with os.fdopen(fd, "w") as output:
            output.write(json.dumps({"approval": APPROVAL, "cited": cite, "hosts": results}, indent=2) + "\n")
    finally:
        os.close(descriptor)
    return results


def main():
    parser = argparse.ArgumentParser(description="Retire regenerable run bulk and finished rehearsal homes, preserving receipts and cited releases")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--active-run", type=Path)
    parser.add_argument("--cite-json", type=json.loads, default={})
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--serving", action="store_true")
    args = parser.parse_args()
    if args.serving:
        print(json.dumps(serving_version()))
        return
    if args.root is None or args.active_run is None:
        parser.error("--root and --active-run are required")
    print(json.dumps(retain(args.root, args.active_run, dry_run=args.dry_run, cite=args.cite_json), indent=2))


if __name__ == "__main__":
    main()
