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
from .proof_archive import archive_idle


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
            if not isinstance(value, dict):
                continue
            pid = value["pid"]
            if not isinstance(pid, int) or pid <= 1:
                continue
            if not value.get("finishedAt") and identity(pid) == value["identity"]:
                os.kill(pid, signal.SIGTERM)
                rows.append({"pid": pid, "outcome": "terminated-captured-pid"})
            else:
                rows.append({"pid": pid, "outcome": "already-exited"})
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
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
    owner = None
    changed = None
    observation = {}
    try:
        while time.time() < job["start"]:
            time.sleep(min(0.5, job["start"] - time.time()))
        first = environment(job["port"])
        version = first["serverVersion"]
        args = SimpleNamespace(drain_s=max(0, int(job["until"] - time.time())), port=job["port"], auth_scopes=("orchestration:read",), strict_auth_cleanup=True)
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
            prompt = f"Call the Bash tool with timeout=600000 and run_in_background=false to run exactly: {command}\nThe explicit 600000 ms Bash timeout is mandatory so the tool does not turn this into a background command. Wait in this one provider turn until that same Bash call returns; do not background it, do not finish this turn while the command runs, and do not reply with a waiting message. The command returns within 9 minutes and prints GATE_CONTINUE or GATE_RELEASED. Whenever it prints GATE_CONTINUE, call the Bash tool again the same way with exactly the same command, in this same turn. Once it prints GATE_RELEASED, reply with exactly {nonce} and nothing else. If the server automatically continues this interrupted turn, keep running the same command the same way until it prints GATE_RELEASED and reply with the same nonce. Do not send messages, edit files, or do other work."
            provider_instance = "claudeAgent"
            if job["provider"] != "claude" or job["model"] != "claude-haiku-4-5":
                raise ValueError("recorder requires pinned Claude Haiku")
            submitted = cli(home, version, "thread", "start", "--provider", provider_instance, "--model", job["model"], "--title", "Live swap recorder", str(project), prompt)
            turn = {"threadId": submitted["threadId"], "runId": submitted["runId"], "nonce": nonce, "provider": job["provider"], "providerInstance": provider_instance, "model": job["model"], "submittedVersion": version, "newPromptsSent": 1}
            thread = turn["threadId"]
            (run / "turn.json").write_text(json.dumps(turn, indent=2) + "\n")
        stop = run / "probe.stop"
        command = ["node", str(Path(__file__).with_name("client.mjs")), "hot-swap-probe", "--tree", job["rpcTree"], "--origin", f"http://127.0.0.1:{job['port']}", "--bearer-file", str(bearer), "--thread", thread, "--output", str(run / "probe.json"), "--stop", str(stop), "--interval-ms", "20", "--save-interval-ms", "250", "--stream-http", "true"]
        process = subprocess.Popen(command, cwd=run, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (run / "probe-process.json").write_text(json.dumps({"pid": process.pid, "identity": identity(process.pid)}) + "\n")
        while time.time() < job["until"]:
            if process.poll() is not None:
                raise ValueError("production client probe exited unexpectedly")
            if (run / "probe.json.status").exists():
                observation = json.loads((run / "probe.json.status").read_text())
            versions = observation.get("servedVersions", [])
            current = versions[-1]["version"] if versions else version
            if current != version:
                changed = changed or time.time()
            else:
                changed = None
            latest = observation.get("latestHttpObservation")
            span = (latest["atMs"] - versions[-1]["atMs"]) / 1000 if changed and latest else 0
            if turn:
                status = turn_state(home, turn)
                if status.get("completedRun"):
                    turn.setdefault("completedVersion", current)
                if (changed and observation.get("subscriptions", 0) > 1) or time.time() >= job["until"] - 45:
                    (run / "release-gate").touch()
                (run / "turn-status.json").write_text(json.dumps({**turn, **status}, indent=2) + "\n")
            if changed and span >= 65:
                break
            time.sleep(0.5)
        if (run / "probe.json").exists():
            probe = json.loads((run / "probe.json").read_text())
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
        watched = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM)
        signal.pthread_sigmask(signal.SIG_BLOCK, watched)
        for number in watched:
            signal.signal(number, signal.SIG_IGN)
        signal.alarm(0)
        teardown = []

        def attempt(name, action):
            try:
                return action()
            except BaseException as failure:
                teardown.append({"step": name, "error": type(failure).__name__})
                return None

        observed = observation.get("servedVersions", [])
        last = observation.get("latestHttpObservation")
        job["settledAfterSwapSeconds"] = max(0, (last["atMs"] - observed[-1]["atMs"]) / 1000) if len(observed) > 1 and last and observed[-1]["version"] != observed[0]["version"] else 0
        job["observationEndedAt"] = time.time()
        attempt("freeze-observation", lambda: (run / "probe.stop").touch())
        if session is not None:
            attempt("revoke-session", lambda: session.__exit__(None, None, None))
        auth = dict(getattr(owner, "session_auth", {}))
        auth["authFileRemoved"] = auth.get("authFileRemoved") is True and not any(run.glob(".restart-rpc-*"))
        job["auth"] = auth
        attempt("stop-gates", lambda: stop_gates(run))
        if process is not None:
            attempt("wait-probe", lambda: process.wait(timeout=10))
            if process.poll() is None:
                attempt("terminate-probe", process.terminate)
                attempt("wait-terminated-probe", lambda: process.wait(timeout=5))
            if process.poll() is None:
                attempt("kill-probe", process.kill)
                attempt("reap-probe", lambda: process.wait(timeout=5))
        if (run / "probe.json").exists():
            final_probe = attempt("read-final-probe", lambda: json.loads((run / "probe.json").read_text()))
            if final_probe is not None:
                probe = final_probe
                cursor = attempt("final-continuity", lambda: continuity(home, thread, probe)) or {"verified": False, "reason": "final continuity failed", "missedEvents": []}
        job["teardownErrors"] = teardown
        inputs = {"job": job, "probe": probe, "turn": turn, "status": status, "cursor": cursor, "error": error}
        attempt("save-receipt-inputs", lambda: (run / "receipt-inputs.json").write_text(json.dumps(inputs) + "\n"))
        value = receipt(run, **inputs)
        if turn and status.get("completedRun"):
            attempt("archive-proof", lambda: archive_idle(home / "runtime/versions" / version / "t3", home, turn["threadId"], lambda step, **fields: print(json.dumps({"step": step, **fields}), flush=True)))
        (run / "finished.json").write_text(json.dumps({"grade": value["grade"], "pid": os.getpid(), "finishedAt": time.time(), "authFileRemoved": auth["authFileRemoved"], "revokeVerified": auth.get("revokeVerified", False), "watcherFinalized": False}) + "\n")
        from .live_swap_cleanup import request_unload

        attempt("unload-recorder-unit", lambda: request_unload(run, job))
    return 1 if error else 0


if __name__ == "__main__":
    raise SystemExit(main())
