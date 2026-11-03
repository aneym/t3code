import json
import os
import shlex
import signal
import subprocess
import tempfile
import time
import uuid
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path

from .release_jobs import write_status
from .suite_process import REMOTE
from .release_manifest import digest
from .suite_plan import load, slug, write
from .suite_provision import setup_script
from .suite_environment import isolated, sanitized_tail, DISK
from .suite_resources import CLEANUP, COW_GATE, COW_LIMIT, TMP, TMP_ROOT, WorkerTerminated, host_slot, job_tmp, worker_signals


RESULT_SCHEMA = "t3nightly.advisory-result/1"
HOSTS = {
    "ax42": ("/home/jobs/repos/t3code", "/srv/cow/t3-wt/t3code-advisory"),
    "forge": ("/home/jobs/repos/t3code", "/home/jobs/repos/t3code-wt"),
    "pc-wsl": ("/home/jobs/repos/t3code", "/home/jobs/repos/t3code-wt"),
    "studio": ("/Volumes/StudioExt/repos/t3code", "/Volumes/StudioExt/repos/t3code-wt"),
}


def now():
    return datetime.now(timezone.utc).isoformat()


def execute(host, words, log, timeout, cwd=None, env=None, stderr=None):
    command = words
    remote = host != "studio"
    if remote:
        receipt = f"/tmp/t3nightly-advisory-{uuid.uuid4().hex}.json"
        command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                   "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", host,
                   shlex.join(["python3", "-c", REMOTE, json.dumps([str(word) for word in words]), str(max(1, timeout)), receipt])]
    process = subprocess.Popen(
        command, cwd=cwd, env=env, stdout=log, stderr=stderr if stderr is not None else subprocess.STDOUT,
        stdin=subprocess.PIPE if remote else subprocess.DEVNULL, start_new_session=True,
    )
    try:
        return process.wait(timeout=max(1, timeout) + (30 if remote else 0))
    except (WorkerTerminated, KeyboardInterrupt, subprocess.TimeoutExpired) as error:
        if remote:
            process.stdin.close()
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                log.write(f"remote cleanup pending: {host}:{receipt}\n")
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            except ProcessLookupError:
                process.wait()
        if isinstance(error, subprocess.TimeoutExpired):
            return 124
        raise
    finally:
        if remote and not process.stdin.closed:
            process.stdin.close()


def prepare(host, repo, tree, source, log):
    code = execute(host, ["git", "-C", repo, "worktree", "add", "--detach", tree, source["commit"]], log, 60)
    if code:
        raise RuntimeError(f"cannot create advisory worktree on {host}; git exited {code}")
    script = "import json,pathlib,sys; root=pathlib.Path(sys.argv[1]); [(root / name).write_text(text) for name, text in json.loads(sys.argv[2]).items()]"
    code = execute(host, ["python3", "-c", script, tree, json.dumps(source["stampedContents"])], log, 30)
    if not code:
        code = execute(host, ["git", "-C", tree, "add", "-u"], log, 30)
    if not code:
        check = f"test \"$(git -C {shlex.quote(tree)} write-tree)\" = {shlex.quote(source['stampedTree'])}"
        code = execute(host, ["bash", "-c", check], log, 30)
    if code:
        raise RuntimeError(f"cannot materialize stamped source on {host}; command exited {code}")


def install_dependencies(host, tree, log):
    store = str(Path(tree).parent / ".advisory-pnpm-store")
    words = isolated(tree, ["vp", "install", "--frozen-lockfile", "--", "--store-dir", store,
                            "--virtual-store-dir", f"{tree}/node_modules/.pnpm", "--package-import-method", "hardlink"], host=host)
    code = execute(host, words, log, 600)
    if code:
        raise RuntimeError(f"dependency install failed on {host}; vp exited {code}")


def cleanup(host, repo, tree, log):
    return execute(host, ["python3", "-c", CLEANUP, repo, tree, HOSTS[host][1]], log, 300)


def tmp_report(host, mode, tree, log):
    with tempfile.TemporaryFile(mode="w+") as output:
        code = execute(host, ["python3", "-c", TMP, mode, job_tmp(tree), TMP_ROOT], output, 300)
        output.seek(0)
        text = output.read()
    log.write(text)
    lines = [line for line in text.splitlines() if line.startswith("{")]
    if code or not lines:
        raise RuntimeError(f"advisory tmp {mode} exited {code}")
    return json.loads(lines[-1])


def shielded(action):
    try:
        return action()
    except WorkerTerminated:
        return action()


def cow_gate(host, log, wait):
    if host != "ax42":
        return 0
    return execute(host, ["python3", "-c", COW_GATE, str(COW_LIMIT), str(wait)], log, wait + 100)


def admit(host, tree, logs, resources):
    gate_deadline = time.monotonic() + 7200
    while True:
        with (logs / "cow-gate.log").open("a") as log:
            if cow_gate(host, log, max(0, round(gate_deadline - time.monotonic()))):
                raise RuntimeError(f"/srv/cow stayed at or above {COW_LIMIT}% for 7200s")
        slot = ExitStack()
        try:
            slot_log = slot.enter_context((logs / "slot.log").open("a"))
            held = slot.enter_context(host_slot(host, tree, slot_log))
            with (logs / "cow-gate.log").open("a") as log:
                if not cow_gate(host, log, 0):
                    resources.enter_context(slot)
                    return held
        except BaseException:
            slot.close()
            raise
        slot.close()


def interpolate(value, temp):
    return value.replace("${{ runner.temp }}", temp).replace("${{runner.temp}}", temp)


def unavailable(host, tree, tools_required, log):
    missing = []
    for tool in tools_required:
        if tool == "sudo":
            continue
        command = f"command -v {shlex.quote(tool)} >/dev/null"
        if tool in ("rustfmt", "cargo-fmt", "cargo-clippy", "clippy-driver", "cargo-nextest", "rustdoc"):
            command += f" && {shlex.quote(tool)} --version >/dev/null 2>&1"
        code = execute(host, isolated(tree, ["bash", "-c", command], host=host), log, 10)
        if code:
            missing.append(tool)
    return missing


def run_step(host, step, tree, log_path, deadline):
    temp = f"{tree}/.advisory-tmp"
    started = time.monotonic()
    row = {"id": step["id"], "name": step["name"], "startedAt": now()}
    with log_path.open("w") as log:
        step_temp = f"{temp}/{step['id']}"
        setup = execute(host, setup_script(step_temp), log, 15)
        if setup:
            row.update(result="unavailable", exit=setup)
        else:
            missing = unavailable(host, tree, step["tools"], log)
            if missing:
                row.update(result="unavailable", missingTools=missing, exit=None)
            else:
                command = interpolate(step["command"], temp)
                missing_file = f"{step_temp}/missing-packages"
                command = f"export PATH={shlex.quote(step_temp + '/shims')}:$PATH T3NIGHTLY_MISSING_PACKAGES={shlex.quote(missing_file)}\n" + command
                values = {key: interpolate(str(value), temp) for key, value in step["environment"].items()}
                words = isolated(tree, ["bash", "-eo", "pipefail", "-c", command], values, host=host)
                with log_path.with_suffix(".stderr.log").open("w") as errors:
                    code = execute(host, words, log, deadline - time.monotonic(), stderr=errors)
                packages = []
                if code == 100:
                    with tempfile.TemporaryFile(mode="w+") as missing_log:
                        read = execute(host, ["bash", "-c", f"test ! -f {shlex.quote(missing_file)} || cat {shlex.quote(missing_file)}"], missing_log, 15)
                        missing_log.seek(0)
                        if read == 0:
                            for line in missing_log:
                                try:
                                    record = json.loads(line)
                                    if isinstance(record, dict) and record["exit"] == 100 and isinstance(record["missingPackages"], list):
                                        packages.extend(package for package in record["missingPackages"] if isinstance(package, str))
                                except (ValueError, KeyError):
                                    continue
                    packages = sorted(set(packages))
                row.update(result="unavailable" if packages else ("pass" if code == 0 else "fail"), exit=code)
                if packages:
                    row["missingPackages"] = packages
    if row["result"] != "pass":
        row["stderrTail"] = sanitized_tail(log_path.with_suffix(".stderr.log") if log_path.with_suffix(".stderr.log").exists() else log_path)
    row["seconds"] = round(time.monotonic() - started, 3)
    row["finishedAt"] = now()
    row["log"] = str(log_path)
    return row


def _run(plan_path, job_id, host, out, selected=None, repo=None, tree=None, keep=False):
    value = load(plan_path)
    job = next((row for row in value["jobs"] if row["id"] == job_id), None)
    if job is None:
        raise ValueError(f"unknown planned job {job_id}")
    if host not in HOSTS or host not in job["hosts"]:
        raise ValueError(f"job {job_id} cannot run on {host}")
    steps = job["steps"]
    if selected:
        wanted = set(selected)
        steps = [row for row in steps if row["id"] in wanted]
        if len(steps) != len(wanted):
            raise ValueError("unknown selected step")
    default_repo, root = HOSTS[host]
    repo = repo or default_repo
    tree = tree or f"{root}/advisory-{value['digest'][:12]}-{slug(job_id)}-{uuid.uuid4().hex[:10]}"
    if host == "ax42" and not os.path.normpath(tree).startswith(root + "/"):
        raise ValueError(f"ax42 advisory worktrees must be under {root}")
    tree = os.path.normpath(tree)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    logs = out.parent / f"{out.stem}-logs"
    logs.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    result = {
        "schema": RESULT_SCHEMA,
        "planDigest": value["digest"],
        "job": job_id,
        "host": host,
        "sourceCommit": value["source"]["commit"],
        "sourceTree": value["source"]["stampedTree"],
        "worktree": tree,
        "complete": not selected,
        "coverage": "upstream-run-steps",
        "workflowActions": job["workflowActions"],
        "workflowActionsHandledBy": "host-provisioning",
        "selectedSteps": [row["id"] for row in steps],
        "steps": [],
        "unexecutedSteps": [row["id"] for row in steps],
        "startedAt": now(),
    }
    if host == "ax42":
        result["tmpPeakBytes"] = 0
    resources = ExitStack()
    attempted = False
    pending = out.with_suffix(".cleanup.json")
    write_status(pending, {"host": host, "repo": repo, "worktree": tree,
                                   "tmp": job_tmp(tree) if host == "ax42" else str(Path(tree) / ".advisory-home/tmp"),
                                   "state": "cleanup-required", "workerPid": os.getpid()})
    try:
        try:
            result["hostSlot"] = admit(host, tree, logs, resources)
            admitted = time.monotonic()
            with (logs / "worktree.log").open("w") as log:
                attempted = True
                if host == "studio":
                    with tempfile.TemporaryFile(mode="w+") as space:
                        code = execute(host, ["python3", "-c", DISK, tree, "free"], space, 15)
                        space.seek(0)
                        if code == 0:
                            result["diskFreeBefore"] = json.loads(space.read())["freeBytes"]
                prepare(host, repo, tree, value["source"], log)
                if job["kind"] != "rust":
                    install_dependencies(host, tree, log)
            deadline = admitted + job["timeoutSeconds"]
            rows = result["steps"]
            stopped = False
            for index, step in enumerate(steps, 1):
                if stopped and "always()" not in (step["condition"] or ""):
                    continue
                row = run_step(host, step, tree, logs / f"{index:02d}-{step['id']}.log", deadline)
                rows.append(row)
                if host == "ax42":
                    try:
                        with (logs / "tmp.log").open("a") as log:
                            result["tmpPeakBytes"] = max(result["tmpPeakBytes"], tmp_report(host, "measure", tree, log)["bytes"])
                    except WorkerTerminated:
                        raise
                    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
                        result.setdefault("tmpMeasureErrors", []).append(str(error))
                stopped = stopped or row["result"] != "pass"
            outcomes = {row["result"] for row in rows}
            status = "fail" if "fail" in outcomes else ("unavailable" if "unavailable" in outcomes else "pass")
            result["steps"] = rows
            executed = {row["id"] for row in rows}
            result["unexecutedSteps"] = [row["id"] for row in steps if row["id"] not in executed]
            result["result"] = status
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            result["error"] = str(error)
            result["result"] = "unavailable"
    finally:
        try:
            if attempted:
                try:
                    with (logs / "disk.log").open("w+") as log:
                        code = shielded(lambda: execute(host, ["python3", "-c", DISK, tree], log, 120))
                        log.seek(0)
                        if not code:
                            result["diskUse"] = json.loads(log.read())
                            if host == "studio" and "diskFreeBefore" in result:
                                with tempfile.TemporaryFile(mode="w+") as space:
                                    code = execute(host, ["python3", "-c", DISK, tree, "free"], space, 15)
                                    space.seek(0)
                                    if code == 0:
                                        after = json.loads(space.read())["freeBytes"]
                                        result["diskUse"].update(privateBytes=max(0, result["diskFreeBefore"] - after),
                                                                 accounting="filesystem free-space delta; concurrent host writes may contribute")
                        else:
                            result["diskMeasureError"] = f"disk measurement exited {code}"
                except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
                    result["diskMeasureError"] = str(error)
                if result.get("result") != "pass":
                    result["stderrTail"] = "\n".join(row.get("stderrTail", "") for row in result["steps"] if row["result"] != "pass") or sanitized_tail(logs / "worktree.log")
            if attempted and host == "ax42":
                try:
                    with (logs / "tmp.log").open("a") as log:
                        result["tmpCleanup"] = shielded(lambda: tmp_report(host, "remove", tree, log))
                    after = result["tmpCleanup"]["after"]
                    if after.get("kept"):
                        result["cleanupError"] = f"advisory tmp kept for holders {after['holders']} holding {after['heldDeleted']} deleted bytes, folder {after['bytes']} bytes: {job_tmp(tree)}"
                    elif after["exists"]:
                        result["cleanupError"] = f"advisory tmp still present: {job_tmp(tree)}"
                except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
                    result["cleanupError"] = f"advisory tmp cleanup failed: {error}"
            if attempted and not keep:
                try:
                    with (logs / "cleanup.log").open("w") as log:
                        result["cleanupExit"] = shielded(lambda: cleanup(host, repo, tree, log))
                    if result["cleanupExit"]:
                        result["cleanupError"] = f"worktree cleanup exited {result['cleanupExit']}"
                except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                    result["cleanupError"] = f"worktree cleanup failed: {error}"
            if "cleanupError" in result:
                result["result"] = "unavailable"
                result.setdefault("error", result["cleanupError"])
        finally:
            resources.close()
    executed = {row["id"] for row in result["steps"]}
    result["unexecutedSteps"] = [row["id"] for row in steps if row["id"] not in executed]
    if not keep and result.get("cleanupExit") == 0 and "cleanupError" not in result:
        pending.unlink(missing_ok=True)
    else:
        result["cleanupRecord"] = str(pending)
    result["seconds"] = round(time.monotonic() - started, 3)
    result["finishedAt"] = now()
    result["digest"] = digest(result)
    write(out, result)
    return result


def run(plan_path, job_id, host, out, selected=None, repo=None, tree=None, keep=False):
    with worker_signals():
        return _run(plan_path, job_id, host, out, selected, repo, tree, keep)
