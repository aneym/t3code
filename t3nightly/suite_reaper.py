import fcntl
import json
import os
import signal
import socket
import subprocess
import time
from pathlib import Path

from .suite_resources import job_tmp
from .suite_worker import HOSTS, cleanup, tmp_report


def alive(pid):
    if type(pid) is not int or pid <= 1:
        raise ValueError("invalid cleanup PID")
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class OutsideGroup(ValueError):
    pass


def members(pgid, tree):
    output = subprocess.check_output(["ps", "-axo", "pid=,pgid=,stat="], text=True)
    pids = [int(pid) for pid, group, state in (line.split() for line in output.splitlines())
            if int(group) == pgid and not state.startswith("Z")]
    verified = []
    for pid in pids:
        if Path("/proc").is_dir():
            try:
                cwd = Path(os.readlink(f"/proc/{pid}/cwd")).resolve()
            except (FileNotFoundError, ProcessLookupError):
                continue
        else:
            result = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True)
            if result.returncode not in (0, 1):
                result.check_returncode()
            name = next((line[1:] for line in result.stdout.splitlines() if line.startswith("n")), None)
            if name is None:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    continue
                except PermissionError:
                    pass
                raise OutsideGroup(f"recorded group {pgid} has member {pid} with an unreadable cwd")
            cwd = Path(name).resolve()
        if cwd != tree and tree not in cwd.parents:
            raise OutsideGroup(f"recorded group {pgid} no longer belongs to {tree}")
        verified.append(pid)
    return verified


def reap(root, log, *, dry_run=False, skip=()):
    results = []
    for path in sorted(Path(root).rglob("*.cleanup.json")):
        row = {"record": str(path)}
        try:
            if path.is_symlink():
                raise ValueError("symlink cleanup record")
            with path.open() as handle:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                record = json.load(handle)
                if record.get("ownerHost", socket.gethostname()) != socket.gethostname():
                    continue
                if record.get("host") in skip:
                    log.write(f"advisory reaper skip: {path} targets deferred host {record['host']}\n")
                    row["state"] = "deferred"
                    results.append(row)
                    continue
                if record.get("state") == "kept":
                    row["state"] = "kept-worktree"
                    results.append(row)
                    continue
                if alive(record["workerPid"]):
                    row["state"] = "live"
                    results.append(row)
                    continue
                host = record["host"]
                tree = Path(record["worktree"])
                expected_tmp = job_tmp(str(tree)) if host == "ax42" else str(tree / ".advisory-home/tmp")
                if (not tree.is_absolute() or not tree.name.startswith("advisory-")
                        or not tree.is_relative_to(HOSTS[host][1]) or record["tmp"] != expected_tmp):
                    raise ValueError("cleanup record paths outside advisory roots")
                if dry_run:
                    row["state"] = "would-reap"
                else:
                    for pgid in record.get("processGroups", []):
                        if type(pgid) is not int or pgid <= 1:
                            raise ValueError("invalid recorded group")
                        try:
                            if members(pgid, tree.resolve()):
                                os.killpg(pgid, signal.SIGTERM)
                                deadline = time.monotonic() + 10
                                while members(pgid, tree.resolve()) and time.monotonic() < deadline:
                                    time.sleep(0.1)
                                if members(pgid, tree.resolve()):
                                    os.killpg(pgid, signal.SIGKILL)
                                    deadline = time.monotonic() + 5
                                    while members(pgid, tree.resolve()) and time.monotonic() < deadline:
                                        time.sleep(0.1)
                                    if members(pgid, tree.resolve()):
                                        raise RuntimeError("recorded step group still alive")
                        except OutsideGroup as error:
                            row.setdefault("skippedGroups", []).append({"pgid": pgid, "reason": str(error)})
                        except ProcessLookupError:
                            pass
                    if host == "ax42":
                        report = tmp_report(host, "remove", str(tree), log)
                        if report["after"].get("exists") or report["after"].get("holders"):
                            raise RuntimeError("advisory tmp still held")
                    if cleanup(host, record["repo"], str(tree), log):
                        raise RuntimeError("guarded worktree cleanup failed")
                    path.unlink()
                    row["state"] = "reaped"
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
            row.update(state="kept", error=str(error))
        results.append(row)
    log.write(json.dumps({"advisoryReaper": results}) + "\n")
    log.flush()
    return results
