import json
import os
import shlex
import signal
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .release_manifest import digest
from .suite_plan import host_provisioning, load, slug, write


RESULT_SCHEMA = "t3nightly.advisory-result/1"
HOSTS = {
    "ax42": ("/home/jobs/repos/t3code", "/home/jobs/repos/t3code-wt"),
    "forge": ("/home/jobs/repos/t3code", "/home/jobs/repos/t3code-wt"),
    "pc-wsl": ("/home/jobs/repos/t3code", "/home/jobs/repos/t3code-wt"),
    "studio": ("/Volumes/StudioExt/repos/t3code", "/Volumes/StudioExt/repos/t3code-wt"),
}


def now():
    return datetime.now(timezone.utc).isoformat()


def execute(host, words, log, timeout, cwd=None, env=None, *, linux_host="ax42"):
    command = words
    wait = timeout
    if host != "studio":
        remote = ["timeout", "--signal=TERM", f"{max(1, int(timeout))}s", *words]
        command = ["ssh", "-o", "BatchMode=yes", linux_host if host == "ax42" else host, shlex.join([str(word) for word in remote])]
        wait += 5
    process = subprocess.Popen(
        command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        return process.wait(timeout=max(1, int(wait)))
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        return 124


def prepare(host, repo, tree, source, log, linux_host):
    code = execute(host, ["git", "-C", repo, "worktree", "add", "--detach", tree, source["commit"]], log, 60, linux_host=linux_host)
    if code:
        raise RuntimeError(f"cannot create advisory worktree on {host}; git exited {code}")
    script = "import json,pathlib,sys; root=pathlib.Path(sys.argv[1]); [(root / name).write_text(text) for name, text in json.loads(sys.argv[2]).items()]"
    code = execute(host, ["python3", "-c", script, tree, json.dumps(source["stampedContents"])], log, 30, linux_host=linux_host)
    if not code:
        code = execute(host, ["git", "-C", tree, "add", "-u"], log, 30, linux_host=linux_host)
    if not code:
        check = f"test \"$(git -C {shlex.quote(tree)} write-tree)\" = {shlex.quote(source['stampedTree'])}"
        code = execute(host, ["bash", "-c", check], log, 30, linux_host=linux_host)
    if code:
        raise RuntimeError(f"cannot materialize stamped source on {host}; command exited {code}")


def install_dependencies(host, tree, log, linux_host):
    if host == "studio":
        env = os.environ.copy()
        env["PATH"] = f"{tree}/node_modules/.bin:{Path.home()}/.vite-plus/bin:" + env.get("PATH", "/usr/local/bin:/usr/bin:/bin")
        env["CI"] = "true"
        code = execute(host, ["vp", "install", "--frozen-lockfile"], log, 600, cwd=tree, env=env, linux_host=linux_host)
    else:
        command = f"cd {shlex.quote(tree)} && export PATH={path(tree)} CI=true && vp install --frozen-lockfile"
        code = execute(host, ["bash", "-c", command], log, 600, linux_host=linux_host)
    if code:
        raise RuntimeError(f"dependency install failed on {host}; vp exited {code}")


def cleanup(host, repo, tree, log, linux_host):
    code = execute(host, ["git", "-C", repo, "worktree", "remove", "--force", tree], log, 60, linux_host=linux_host)
    if not code:
        code = execute(host, ["rm", "-f", "--", tree], log, 15, linux_host=linux_host)
    return code


def interpolate(value, temp):
    return value.replace("${{ runner.temp }}", temp).replace("${{runner.temp}}", temp)


def path(tree):
    return f"{tree}/node_modules/.bin:$HOME/.vite-plus/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin"


def environment(step, tree, temp):
    env = {key: os.environ[key] for key in ("HOME", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    env.update({
        "PATH": f"{tree}/node_modules/.bin:{Path.home()}/.vite-plus/bin:" + os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "RUNNER_TEMP": temp,
        "GITHUB_OUTPUT": f"{temp}/github-output",
        "GITHUB_STEP_SUMMARY": f"{temp}/github-summary",
        "CI": "true",
    })
    for key, value in step["environment"].items():
        if key != "PATH":
            env[key] = interpolate(str(value), temp)
    return env


def remote_environment(step, tree, temp):
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
    return "export " + " ".join(exports)


def unavailable(host, tree, tools_required, log, linux_host):
    missing = []
    for tool in tools_required:
        command = f"export PATH={path(tree)}; command -v {shlex.quote(tool)} >/dev/null"
        if tool == "rustfmt":
            command += " && rustfmt --version >/dev/null 2>&1"
        code = execute(host, ["bash", "-c", command], log, 10, linux_host=linux_host)
        if code:
            missing.append(tool)
    return missing


def run_step(host, step, tree, log_path, deadline, linux_host):
    temp = f"{tree}/.advisory-tmp"
    started = time.monotonic()
    row = {"id": step["id"], "name": step["name"], "startedAt": now()}
    with log_path.open("w") as log:
        if step.get("hostProvisioning") or host_provisioning(step["command"]):
            reason = "host provisioning step was not executed"
            log.write(reason + "\n")
            row.update(result="unavailable", reason=reason, exit=None)
            row["seconds"] = round(time.monotonic() - started, 3)
            row["finishedAt"] = now()
            row["log"] = str(log_path)
            return row
        setup = execute(host, ["mkdir", "-p", temp], log, 15, linux_host=linux_host)
        if setup:
            row.update(result="unavailable", exit=setup)
        else:
            missing = unavailable(host, tree, step["tools"], log, linux_host)
            if missing:
                row.update(result="unavailable", missingTools=missing, exit=None)
            else:
                command = interpolate(step["command"], temp)
                if host == "studio":
                    words = ["bash", "-eo", "pipefail", "-c", command]
                    code = execute(host, words, log, deadline - time.monotonic(), cwd=tree, env=environment(step, tree, temp), linux_host=linux_host)
                else:
                    remote = f"cd {shlex.quote(tree)} && {remote_environment(step, tree, temp)} && bash -eo pipefail -c {shlex.quote(command)}"
                    code = execute(host, ["bash", "-c", remote], log, deadline - time.monotonic(), linux_host=linux_host)
                row.update(result="pass" if code == 0 else "fail", exit=code)
    row["seconds"] = round(time.monotonic() - started, 3)
    row["finishedAt"] = now()
    row["log"] = str(log_path)
    return row


def run(plan_path, job_id, host, out, selected=None, repo=None, tree=None, keep=False, *, linux_host="ax42"):
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
    attempted = False
    try:
        try:
            with (logs / "worktree.log").open("w") as log:
                attempted = True
                prepare(host, repo, tree, value["source"], log, linux_host)
                install_dependencies(host, tree, log, linux_host)
            deadline = started + job["timeoutSeconds"]
            rows = []
            stopped = False
            for index, step in enumerate(steps, 1):
                if stopped and "always()" not in (step["condition"] or ""):
                    continue
                row = run_step(host, step, tree, logs / f"{index:02d}-{step['id']}.log", deadline, linux_host)
                rows.append(row)
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
        if attempted and not keep:
            with (logs / "cleanup.log").open("w") as log:
                result["cleanupExit"] = cleanup(host, repo, tree, log, linux_host)
            if result["cleanupExit"]:
                result["result"] = "unavailable"
                result["error"] = f"worktree cleanup exited {result['cleanupExit']}"
    result["seconds"] = round(time.monotonic() - started, 3)
    result["finishedAt"] = now()
    result["digest"] = digest(result)
    write(out, result)
    return result
