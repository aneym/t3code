import json
import math
import os
import shlex
import signal
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path
from types import SimpleNamespace

from .install_rpc import restart_session
from .live_swap_evidence import continuity, query, receipt, turn_state
from .rehearsal_waiter import identity


def environment(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/.well-known/t3/environment", timeout=3) as response:
        return json.load(response)


def cli(home, version, *args):
    binary = home / "runtime/versions" / version / "t3"
    result = subprocess.run([str(binary), *args, "--json", "--base-dir", str(home)], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError("recorder CLI request failed; no credential-bearing output retained")
    return json.loads(result.stdout)


def stop_gates(run):
    rows = []
    (run / "release-gate").touch()
    for path in run.glob("gate-*.json"):
        try:
            value = json.loads(path.read_text())
            pid = value["pid"]
            if not isinstance(pid, int) or pid <= 1:
                continue
            if not value.get("finishedAt") and identity(pid) == value["identity"]:
                os.kill(pid, signal.SIGTERM)
                rows.append({"pid": pid, "outcome": "terminated-captured-pid"})
            else:
                rows.append({"pid": pid, "outcome": "already-exited"})
        except (OSError, ValueError, KeyError):
            rows.append({"receipt": path.name, "outcome": "unreadable-no-signal"})
    (run / "gate-cleanup.json").write_text(json.dumps(rows, indent=2) + "\n")


def main():
    run = Path(sys.argv[1]).resolve()
    job = json.loads((run / "job.json").read_text())
    home = Path(job["home"])
    if os.getpgrp() != os.getpid():
        os.setsid()
    (run / "process.json").write_text(json.dumps({"pid": os.getpid(), "pgid": os.getpgrp(), "identity": identity(os.getpid()), "label": job["label"], "hardDeadline": job["hardDeadline"]}, indent=2) + "\n")

    def interrupted(number, frame):
        raise TimeoutError("recorder signal " + signal.Signals(number).name)

    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
        signal.signal(number, interrupted)
    signal.alarm(max(1, math.ceil(job["hardDeadline"] - time.time())))
    probe = {}
    turn = {}
    status = {}
    cursor = {"verified": False, "missedEvents": []}
    error = None
    process = None
    session = None
    version = None
    changed = None
    try:
        while time.time() < job["start"]:
            time.sleep(min(0.5, job["start"] - time.time()))
        first = environment(job["port"])
        version = first["serverVersion"]
        args = SimpleNamespace(drain_s=max(0, int(job["until"] - time.time())), port=job["port"])
        owner = SimpleNamespace(args=args, home=home, state=run, runtime=lambda value: home / "runtime/versions" / value / "t3")
        session = restart_session(owner, version)
        bearer = session.__enter__()
        thread = job["thread"]
        if job["turn"]:
            project = Path.home() / ".t3/scratch"
            registered = query(home, "SELECT 1 FROM projection_projects WHERE workspace_root=? AND deleted_at IS NULL", (str(project),))
            if not registered:
                raise ValueError("registered ~/.t3/scratch project required; recorder does not register projects")
            nonce = "LIVE_SWAP_" + uuid.uuid4().hex
            gate = [sys.executable, "-m", "t3nightly.live_swap_gate", "--run", str(run), "--deadline", str(job["until"] - 45)]
            command = "env PYTHONPATH=" + shlex.quote(str(Path(__file__).resolve().parent.parent)) + " " + shlex.join(gate)
            prompt = f"Use Bash in the foreground to run exactly: {command}\nWait for that command; do not background it. Then reply with exactly {nonce} and nothing else. If the server automatically continues this interrupted turn, finish this same command and reply with the same nonce. Do not send messages, edit files, or do other work."
            submitted = cli(home, version, "thread", "start", "--provider", job["provider"], "--model", job["model"], "--title", "Live swap recorder", str(project), prompt)
            turn = {"threadId": submitted["threadId"], "runId": submitted["runId"], "nonce": nonce, "provider": job["provider"], "model": job["model"], "submittedVersion": version, "newPromptsSent": 1}
            thread = turn["threadId"]
            (run / "turn.json").write_text(json.dumps(turn, indent=2) + "\n")
        stop = run / "probe.stop"
        command = ["node", str(Path(__file__).with_name("client.mjs")), "hot-swap-probe", "--tree", job["rpcTree"], "--origin", f"http://127.0.0.1:{job['port']}", "--bearer-file", str(bearer), "--thread", thread, "--output", str(run / "probe.json"), "--stop", str(stop), "--interval-ms", "500"]
        process = subprocess.Popen(command, cwd=run, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (run / "probe-process.json").write_text(json.dumps({"pid": process.pid, "identity": identity(process.pid)}) + "\n")
        while time.time() < min(job["until"], changed + 60 if changed else job["until"]):
            if process.poll() is not None:
                raise ValueError("production client probe exited unexpectedly")
            if (run / "probe.json").exists():
                probe = json.loads((run / "probe.json").read_text())
            versions = probe.get("servedVersions", [])
            current = versions[-1]["version"] if versions else version
            if current != version and changed is None:
                changed = time.time()
            if turn:
                status = turn_state(home, turn)
                if status.get("completedRun"):
                    turn.setdefault("completedVersion", current)
                if (changed and len(probe.get("subscriptions", [])) > 1) or time.time() >= job["until"] - 45:
                    (run / "release-gate").touch()
                (run / "turn-status.json").write_text(json.dumps({**turn, **status}, indent=2) + "\n")
            time.sleep(0.5)
        if turn:
            (run / "release-gate").touch()
            status = turn_state(home, turn)
        cursor = continuity(home, thread, probe)
        settle = time.monotonic() + 8
        while not cursor["verified"] and time.monotonic() < settle:
            time.sleep(0.25)
            probe = json.loads((run / "probe.json").read_text())
            cursor = continuity(home, thread, probe)
    except BaseException as failure:
        error = type(failure).__name__ + (": " + str(failure) if isinstance(failure, (ValueError, TimeoutError)) else "")
    finally:
        for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(number, signal.SIG_IGN)
        (run / "probe.stop").touch()
        stop_gates(run)
        if process is not None:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        if (run / "probe.json").exists():
            probe = json.loads((run / "probe.json").read_text())
        if session is not None:
            try:
                session.__exit__(None, None, None)
            except BaseException:
                error = error or "auth-revoke-or-cleanup-failed"
        signal.alarm(0)
        job["settledAfterSwapSeconds"] = time.time() - changed if changed else 0
        value = receipt(run, job, probe, turn, status, cursor, error)
        (run / "finished.json").write_text(json.dumps({"grade": value["grade"], "pid": os.getpid(), "finishedAt": time.time(), "authFileRemoved": not any(run.glob(".restart-rpc-*"))}) + "\n")
    return 1 if value["grade"] == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
