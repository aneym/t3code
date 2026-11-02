import shlex
import subprocess
import time

from .release_hold_state import event, save


def pending(row):
    return bool(row.get("quarantineIntentAt") and not row.get("quarantineCleared"))


def quarantine(config, root, action):
    if config["sandbox"]:
        command = config.get("sandboxQuarantineCommand")
        if command:
            subprocess.run([command, "forge", action, "quarantine"], capture_output=True, timeout=10, check=True)
    else:
        subprocess.run(["ssh", "-oBatchMode=yes", "-oConnectTimeout=5", "ax42",
                        shlex.join(["fleet-drain", "forge", action, "quarantine"])],
                       capture_output=True, timeout=30, check=True)
    event(root, "quarantine-" + action, sandbox=config["sandbox"])


def add_quarantine(config, root, row):
    if not row.get("quarantineIntentAt"):
        save(root, row, quarantineIntentAt=time.time())
        event(root, "quarantine-intent")
    if row.get("quarantineAt"):
        return
    try:
        quarantine(config, root, "add")
    except (OSError, subprocess.SubprocessError) as error:
        event(root, "quarantine-add-retry", error=type(error).__name__, warning=True)
        if time.time() < row["quarantineIntentAt"] + config["quarantineRetrySeconds"]:
            return
        event(root, "quarantine-failed", warning=True, error=type(error).__name__)
        save(root, row, quarantineFailed=True)
        return
    save(root, row, quarantineAt=time.time())


def clear_quarantine(config, root, row):
    if not pending(row):
        return True
    try:
        quarantine(config, root, "clear")
    except (OSError, subprocess.SubprocessError) as error:
        event(root, "QUARANTINE-CLEAR-FAILED", warning=True, error=type(error).__name__)
        return False
    save(root, row, quarantineCleared=time.time())
    return True
