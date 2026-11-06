import json
import subprocess


def archive(runtime, home, thread_id, log):
    fields = {"threadId": thread_id}
    try:
        result = subprocess.run(
            [str(runtime), "thread", "archive", thread_id, "--json", "--base-dir", str(home)],
            capture_output=True, text=True, timeout=30, check=False,
        )
        fields.update(ok=result.returncode == 0, exitCode=result.returncode)
    except (OSError, subprocess.SubprocessError) as error:
        fields.update(ok=False, errorType=type(error).__name__)
    log("proof-archive", **fields)
    return fields["ok"]


def archive_idle(runtime, home, thread_id, log):
    try:
        result = subprocess.run(
            [str(runtime), "thread", "show", thread_id, "--messages", "0", "--json", "--base-dir", str(home)],
            capture_output=True, text=True, timeout=30, check=False,
        )
        if result.returncode:
            log("proof-archive-skipped", threadId=thread_id, exitCode=result.returncode)
            return False
        thread = json.loads(result.stdout)["thread"]
        if thread.get("archived"):
            return True
        if thread.get("activeRunId") or thread.get("pendingRequestCount") != 0 or thread.get("awaitedBackgroundTaskCount", 0) or thread.get("status") not in ("completed", "idle", "cancelled", "failed", "interrupted", "rolled_back"):
            log("proof-archive-skipped", threadId=thread_id, reason="not-idle")
            return False
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        log("proof-archive-skipped", threadId=thread_id, errorType=type(error).__name__)
        return False
    return archive(runtime, home, thread_id, log)
