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

from .release_manifest import digest
from .suite_plan import load, slug, write
from .suite_provision import linux_exports, setup_script, studio_path
from .suite_resources import CLEANUP, COW_GATE, COW_LIMIT, TMP, TMP_ROOT, WorkerTerminated, cache_exports, host_slot, job_tmp, worker_signals


RESULT_SCHEMA = "t3nightly.advisory-result/1"
HOSTS = {
    "ax42": ("/home/jobs/repos/t3code", "/srv/cow/t3-wt/t3code-advisory"),
    "forge": ("/home/jobs/repos/t3code", "/home/jobs/repos/t3code-wt"),
    "pc-wsl": ("/home/jobs/repos/t3code", "/home/jobs/repos/t3code-wt"),
    "studio": ("/Volumes/StudioExt/repos/t3code", "/Volumes/StudioExt/repos/t3code-wt"),
}


def now():
    return datetime.now(timezone.utc).isoformat()


def execute(host, words, log, timeout, cwd=None, env=None):
    command = words
    wait = timeout
    pidfile = None
    if host != "studio":
        pidfile = f"/tmp/t3nightly-advisory-{uuid.uuid4().hex}.pid"
        inner = shlex.join(["timeout", "--signal=TERM", f"{max(1, int(timeout))}s", *[str(word) for word in words]])
        script = f"{inner} </dev/null & child=$!; echo $child > {shlex.quote(pidfile)}; wait $child; code=$?; rm -f {shlex.quote(pidfile)}; exit $code"
        command = ["ssh", "-o", "BatchMode=yes", host, shlex.join(["bash", "-c", script])]
        wait += 5
    process = subprocess.Popen(
        command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        return process.wait(timeout=max(1, int(wait)))
    except WorkerTerminated:
        if pidfile and process.poll() is None:
            quoted = shlex.quote(pidfile)
            stop = f"for i in $(seq 50); do test -s {quoted} && break; sleep 0.1; done; test -s {quoted} && kill -TERM \"$(cat {quoted})\"; rm -f {quoted}"
            try:
                subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, stop],
                               stdout=log, stderr=subprocess.STDOUT, timeout=20, check=False)
            except subprocess.TimeoutExpired:
                log.write(f"remote stop timed out for {pidfile}\n")
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            except (ProcessLookupError, PermissionError):
                process.wait()
        raise
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        return 124


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
    if host == "studio":
        env = os.environ.copy()
        env["PATH"] = studio_path(tree)
        env["CI"] = "true"
        code = execute(host, ["vp", "install", "--frozen-lockfile"], log, 600, cwd=tree, env=env)
    else:
        store = "/srv/cow/t3-wt/.advisory-pnpm-store" if host == "ax42" else "$HOME/.local/share/t3nightly/pnpm-store"
        command = f"cd {shlex.quote(tree)} && export PATH={path(tree)} CI=true && {linux_exports()} && {cache_exports(host, tree)} && PNPM_CONFIG_VIRTUAL_STORE_TYPE=global PNPM_CONFIG_GLOBAL_VIRTUAL_STORE_DIR=\"{store}/links\" vp install --frozen-lockfile -- --store-dir \"{store}\" --package-import-method clone-or-copy"
        code = execute(host, ["bash", "-c", command], log, 600)
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


def cow_gate(host, log):
    if host != "ax42":
        return 0
    return execute(host, ["python3", "-c", COW_GATE, str(COW_LIMIT), "7200"], log, 7300)


def interpolate(value, temp):
    return value.replace("${{ runner.temp }}", temp).replace("${{runner.temp}}", temp)


def path(tree):
    return f"{tree}/node_modules/.bin:$HOME/.vite-plus/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"


def environment(step, tree, temp):
    env = {key: os.environ[key] for key in ("HOME", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env.update({
        "PATH": studio_path(tree),
        "RUNNER_TEMP": temp,
        "GITHUB_OUTPUT": f"{temp}/github-output",
        "GITHUB_STEP_SUMMARY": f"{temp}/github-summary",
        "CI": "true",
    })
    for key, value in step["environment"].items():
        if key != "PATH":
            env[key] = interpolate(str(value), temp)
    return env


def remote_environment(step, tree, temp, host):
    values = {
        "PATH": path(tree),
        "RUNNER_TEMP": temp,
        "GITHUB_OUTPUT": f"{temp}/github-output",
        "GITHUB_STEP_SUMMARY": f"{temp}/github-summary",
        "CI": "true",
    }
    for key, value in step["environment"].items():
        values[key] = interpolate(str(value), temp)
    exports = []
    for key, value in values.items():
        if key == "PATH":
            encoded = shlex.quote(f"{tree}/node_modules/.bin") + ":$HOME/.vite-plus/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
        else:
            encoded = shlex.quote(value)
        exports.append(f"{key}={encoded}")
    return "export " + " ".join(exports) + " && " + linux_exports() + " && " + cache_exports(host, tree)


def unavailable(host, tree, tools_required, log):
    missing = []
    for tool in tools_required:
        search_path = shlex.quote(studio_path(tree)) if host == "studio" else path(tree)
        command = f"export PATH={search_path}; command -v {shlex.quote(tool)} >/dev/null"
        if tool == "sudo":
            continue
        if tool == "rustfmt":
            command += " && rustfmt --version >/dev/null 2>&1"
        code = execute(host, ["bash", "-c", command], log, 10)
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
                if host == "studio":
                    words = ["bash", "-eo", "pipefail", "-c", command]
                    code = execute(host, words, log, deadline - time.monotonic(), cwd=tree, env=environment(step, tree, temp))
                else:
                    remote = f"cd {shlex.quote(tree)} && {remote_environment(step, tree, temp, host)} && bash -eo pipefail -c {shlex.quote(command)}"
                    code = execute(host, ["bash", "-c", remote], log, deadline - time.monotonic())
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
    try:
        try:
            with (logs / "cow-gate.log").open("w") as log:
                if cow_gate(host, log):
                    raise RuntimeError(f"/srv/cow stayed at or above {COW_LIMIT}% for 7200s")
            slot_log = resources.enter_context((logs / "slot.log").open("w"))
            result["hostSlot"] = resources.enter_context(host_slot(host, tree, slot_log))
            admitted = time.monotonic()
            with (logs / "worktree.log").open("w") as log:
                attempted = True
                prepare(host, repo, tree, value["source"], log)
                install_dependencies(host, tree, log)
            deadline = admitted + job["timeoutSeconds"]
            rows = []
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
            if attempted and host == "ax42":
                try:
                    with (logs / "tmp.log").open("a") as log:
                        result["tmpCleanup"] = tmp_report(host, "remove", tree, log)
                    if result["tmpCleanup"]["after"]["exists"]:
                        result["cleanupError"] = f"advisory tmp still present: {job_tmp(tree)}"
                except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
                    result["cleanupError"] = f"advisory tmp cleanup failed: {error}"
            if attempted and not keep:
                try:
                    with (logs / "cleanup.log").open("w") as log:
                        result["cleanupExit"] = cleanup(host, repo, tree, log)
                    if result["cleanupExit"]:
                        result["cleanupError"] = f"worktree cleanup exited {result['cleanupExit']}"
                except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                    result["cleanupError"] = f"worktree cleanup failed: {error}"
            if "cleanupError" in result:
                result["result"] = "unavailable"
                result.setdefault("error", result["cleanupError"])
        finally:
            resources.close()
    result["seconds"] = round(time.monotonic() - started, 3)
    result["finishedAt"] = now()
    result["digest"] = digest(result)
    write(out, result)
    return result


def run(plan_path, job_id, host, out, selected=None, repo=None, tree=None, keep=False):
    with worker_signals():
        return _run(plan_path, job_id, host, out, selected, repo, tree, keep)
