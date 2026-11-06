import json
import subprocess
import time


def log_event(log, step, **fields):
    try:
        log(step, **fields)
    except Exception:
        try:
            print(json.dumps({"step": step, **fields}), flush=True)
        except Exception:
            pass


def command(runtime, home, thread_id, action, deadline):
    timeout = deadline - time.monotonic()
    if timeout <= 0:
        raise TimeoutError("proof archive budget exhausted")
    return subprocess.run(
        [str(runtime), "thread", action, thread_id, *(["--messages", "0"] if action == "show" else []), "--json", "--base-dir", str(home)],
        capture_output=True, text=True, timeout=timeout, check=False,
    )


def archive(runtime, home, thread_id, log, *, interrupt=False, deadline=None):
    fields = {"threadId": thread_id}
    try:
        deadline = deadline if deadline is not None else time.monotonic() + 20
        if interrupt:
            try:
                command(runtime, home, thread_id, "interrupt", min(deadline, time.monotonic() + 5))
            except Exception:
                pass
        result = command(runtime, home, thread_id, "archive", deadline)
        fields.update(ok=result.returncode == 0, exitCode=result.returncode)
    except Exception as error:
        fields.update(ok=False, errorType=type(error).__name__)
    log_event(log, "proof-archive", **fields)
    return fields["ok"]


def archive_idle(runtime, home, thread_id, log, *, deadline=None, interrupt=False):
    try:
        deadline = deadline if deadline is not None else time.monotonic() + 20
        result = command(runtime, home, thread_id, "show", deadline)
        if result.returncode:
            log_event(log, "proof-archive-skipped", threadId=thread_id, exitCode=result.returncode)
            return False
        thread = json.loads(result.stdout)["thread"]
        if thread.get("archived"):
            return True
        if thread.get("activeRunId") or thread.get("pendingRequestCount") != 0 or thread.get("awaitedBackgroundTaskCount", 0) or thread.get("status") not in ("completed", "idle", "cancelled", "failed", "interrupted", "rolled_back"):
            if interrupt:
                return archive(runtime, home, thread_id, log, interrupt=True, deadline=deadline)
            log_event(log, "proof-archive-skipped", threadId=thread_id, reason="not-idle")
            return False
        return archive(runtime, home, thread_id, log, deadline=deadline)
    except Exception as error:
        log_event(log, "proof-archive-skipped", threadId=thread_id, errorType=type(error).__name__)
        return False


def archive_chat(run, version, thread_id, *, interrupt=False):
    try:
        return archive(run.runtime(version), run.home, thread_id, run.step, interrupt=interrupt)
    except Exception as error:
        log_event(run.step, "proof-archive", threadId=thread_id, ok=False, errorType=type(error).__name__)
        return False
